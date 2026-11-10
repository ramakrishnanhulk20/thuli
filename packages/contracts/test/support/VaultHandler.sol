// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ThuliVault} from "../../src/ThuliVault.sol";
import {StandardTree} from "./StandardTree.sol";
import {TestToken} from "./TestToken.sol";

/// @notice Drives one vault the way its real users would, in random order, and keeps a model of what the roots and
/// money should be. The agent here may be stolen: it posts lists whose amounts the deposit cannot cover and declares
/// a total that hides it, which is exactly when the vault's own limits have to hold.
/// @dev Every action decides first whether the vault must accept or refuse it. A refusal is asserted with
/// vm.expectRevert, and the suite runs with fail_on_revert, so a vault that accepts a forged claim, an outsider's root
/// or an early withdrawal, or refuses a claim claimable() promised, fails the run on the spot.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    error WrongPayout(uint256 expected, uint256 paid);

    /// @dev The roots as the vault should hold them. `pendingAt` runs on the unpaused clock and moves at each unpause.
    struct RootModel {
        bytes32 active;
        bytes32 pending;
        uint64 pendingAt;
        uint64 pausedAt;
        bytes32 tracked;
        uint64 trackedUnpaused;
        bytes32 lastSeenActive;
    }

    struct Setup {
        ThuliVault vault;
        TestToken usd;
        address owner;
        address[] actors;
        address[] agentKeys;
        address stranger;
    }

    ThuliVault public immutable vault;
    TestToken public immutable usd;
    address public immutable owner;
    address public immutable stranger;
    uint256 public immutable cap;
    uint32 public immutable delay;

    address[] internal _actors;
    address[] internal _agentKeys;
    address public currentAgent;

    mapping(bytes32 root => bytes32[] tree) internal _treeOf;
    mapping(bytes32 root => uint256[] amounts) internal _amountsOf;

    RootModel internal _model;
    uint256 public ghostWithdrawn;
    uint256 public ghostDonated;
    uint64 public lastEnd;

    bool public endWentBack;
    bool public rootActivatedEarly;

    constructor(Setup memory s) {
        vault = s.vault;
        usd = s.usd;
        owner = s.owner;
        stranger = s.stranger;
        _actors = s.actors;
        _agentKeys = s.agentKeys;
        currentAgent = s.vault.agent();
        cap = s.vault.perWalletCap();
        delay = s.vault.rootDelay();
        lastEnd = s.vault.endTime();
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 3 * cap);
        if (block.timestamp < vault.endTime()) {
            usd.mint(owner, amount);
            vm.startPrank(owner);
            usd.approve(address(vault), amount);
            vault.deposit(amount);
            vm.stopPrank();
        }
        _afterEach();
    }

    /// @dev Refused while paused, and when the delay would end at or after the end, since such a root never pays.
    function postRoot(uint256 seed) external {
        uint64 end = vault.endTime();
        if (block.timestamp < end) {
            (bytes32 root, uint256 sum) = _storeList(seed);
            uint256 declared = sum < vault.deposited() ? sum : vault.deposited();
            uint64 claimableAt = uint64(block.timestamp) + delay;
            bool paused = vault.paused();
            bool accepted = !paused && claimableAt < end;
            if (paused) vm.expectRevert(Pausable.EnforcedPause.selector);
            else if (!accepted) vm.expectRevert(abi.encodeWithSelector(ThuliVault.RootWouldNotActivate.selector, claimableAt, end));
            vm.prank(currentAgent);
            vault.postRoot(root, declared);
            if (accepted) {
                _matureGhost();
                (_model.pending, _model.pendingAt) = (root, claimableAt);
                (_model.tracked, _model.trackedUnpaused) = (root, 0);
            }
        }
        _afterEach();
    }

    function claim(uint256 actorSeed, bool selfSubmitted) external {
        bytes32 active = vault.state().activeRoot;
        if (active != bytes32(0)) {
            uint256 i = actorSeed % _actors.length;
            address account = _actors[i];
            uint256 amount = _amountsOf[active][i];
            bytes32[] memory proof = _proofFor(active, i, amount);
            uint256 expected = vault.claimable(account, amount);
            uint256 balanceBefore = usd.balanceOf(account);
            if (expected == 0) vm.expectRevert();
            vm.prank(selfSubmitted ? account : stranger);
            vault.claim(account, amount, proof);
            uint256 paid = usd.balanceOf(account) - balanceBefore;
            if (paid != expected) revert WrongPayout(expected, paid);
            if (expected != 0) _matureGhost();
        }
        _afterEach();
    }

    function claimMoreThanTheLeaf(uint256 actorSeed, uint256 extra) external {
        bytes32 active = vault.state().activeRoot;
        if (active != bytes32(0)) {
            uint256 i = actorSeed % _actors.length;
            uint256 amount = _amountsOf[active][i];
            bytes32[] memory proof = _proofFor(active, i, amount);
            uint256 forged = amount + bound(extra, 1, cap);
            vm.expectRevert();
            vm.prank(stranger);
            vault.claim(_actors[i], forged, proof);
        }
        _afterEach();
    }

    function cancelRoot() external {
        bool cancellable = vault.state().pendingRoot != bytes32(0);
        if (!cancellable) vm.expectRevert();
        vm.prank(owner);
        vault.cancelRoot();
        if (cancellable) (_model.pending, _model.pendingAt) = (bytes32(0), 0);
        _afterEach();
    }

    function rotateAgent(uint256 seed) external {
        address next = _agentKeys[seed % _agentKeys.length];
        vm.prank(owner);
        vault.setAgent(next);
        _matureGhost();
        (_model.pending, _model.pendingAt) = (bytes32(0), 0);
        currentAgent = next;
        _afterEach();
    }

    function outsiderPostsRoot(uint256 who, bytes32 root) external {
        address caller = _outsider(who);
        if (caller != currentAgent) {
            vm.expectRevert(abi.encodeWithSelector(ThuliVault.NotAgent.selector, caller));
            vm.prank(caller);
            vault.postRoot(root == bytes32(0) ? bytes32(uint256(1)) : root, 0);
        }
        _afterEach();
    }

    function wait(uint256 secondsToSkip) external {
        _advance(bound(secondsToSkip, 0, 3 days));
        _afterEach();
    }

    /// @dev Extensions and pauses keep moving the end out, so plain waits alone almost never reach a withdrawal.
    function jumpPastEnd(uint256 extra) external {
        uint256 from = block.timestamp > vault.endTime() ? block.timestamp : vault.endTime();
        _advance(from + bound(extra, 0, 1 days) - block.timestamp);
        _afterEach();
    }

    /// @dev Pausing records a root that was already due; unpausing moves a pending root by the time paused.
    function togglePause() external {
        bool paused = vault.paused();
        vm.prank(owner);
        if (paused) {
            vault.unpause();
            uint64 pausedFor = uint64(block.timestamp) - _model.pausedAt;
            if (_model.pending != bytes32(0)) _model.pendingAt += pausedFor;
            _model.pausedAt = 0;
        } else {
            vault.pause();
            _matureGhost();
            _model.pausedAt = uint64(block.timestamp);
        }
        _afterEach();
    }

    /// @dev Once the end has passed the campaign stays ended, so a withdrawal is always final.
    function extendEnd(uint256 by) external {
        uint64 currentEnd = vault.endTime();
        uint64 newEnd = currentEnd + uint64(bound(by, 1, 30 days));
        if (newEnd <= block.timestamp + vault.MAX_END_AHEAD()) {
            if (block.timestamp >= currentEnd) vm.expectRevert(ThuliVault.CampaignEnded.selector);
            vm.prank(owner);
            vault.extendEnd(newEnd);
        }
        _afterEach();
    }

    /// @dev C31: refused before the end and while paused, whatever is in the vault.
    function withdraw() external {
        uint256 balance = usd.balanceOf(address(vault));
        bool allowed = block.timestamp >= vault.endTime() && !vault.paused() && balance != 0;
        if (!allowed) vm.expectRevert();
        vm.prank(owner);
        vault.withdrawAfterEnd(owner);
        if (allowed) ghostWithdrawn += balance;
        _afterEach();
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, cap);
        usd.mint(address(vault), amount);
        ghostDonated += amount;
        _afterEach();
    }

    function actorCount() external view returns (uint256) {
        return _actors.length;
    }

    function actor(uint256 i) external view returns (address) {
        return _actors[i];
    }

    /// @dev The model's roots as the vault should report them right now, a finished delay counting as active and a
    /// pause holding the pending root's claimable time that far from now.
    function expectedRoots() external view returns (bytes32 active, bytes32 pending, uint64 pendingAt) {
        RootModel memory m = _model;
        bool paused = m.pausedAt != 0;
        if (m.pending != bytes32(0) && !paused && block.timestamp >= m.pendingAt) return (m.pending, bytes32(0), 0);
        pendingAt = m.pending != bytes32(0) && paused ? m.pendingAt + uint64(block.timestamp) - m.pausedAt : m.pendingAt;
        return (m.active, m.pending, pendingAt);
    }

    function _storeList(uint256 seed) internal returns (bytes32 root, uint256 sum) {
        uint256 count = _actors.length;
        uint256[] memory amounts = new uint256[](count);
        bytes32[] memory leaves = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            amounts[i] = uint256(keccak256(abi.encode(seed, i))) % (2 * cap + 1);
            sum += amounts[i];
            leaves[i] = StandardTree.leafHash(block.chainid, address(vault), _actors[i], amounts[i]);
        }
        bytes32[] memory tree = StandardTree.build(leaves);
        root = StandardTree.root(tree);
        _treeOf[root] = tree;
        _amountsOf[root] = amounts;
    }

    function _proofFor(bytes32 root, uint256 i, uint256 amount) internal view returns (bytes32[] memory) {
        bytes32 leaf = StandardTree.leafHash(block.chainid, address(vault), _actors[i], amount);
        return StandardTree.proof(_treeOf[root], leaf);
    }

    function _outsider(uint256 who) internal view returns (address) {
        uint256 pick = who % 4;
        if (pick == 0) return owner;
        if (pick == 1) return stranger;
        if (pick == 2) return _actors[who % _actors.length];
        return _agentKeys[who % _agentKeys.length];
    }

    function _matureGhost() internal {
        if (_model.pausedAt == 0 && _model.pending != bytes32(0) && block.timestamp >= _model.pendingAt) {
            (_model.active, _model.pending, _model.pendingAt) = (_model.pending, bytes32(0), 0);
        }
    }

    /// @dev Time only moves here, so the unpaused seconds since the last post are counted exactly.
    function _advance(uint256 secondsToSkip) internal {
        if (!vault.paused()) _model.trackedUnpaused += uint64(secondsToSkip);
        skip(secondsToSkip);
    }

    function _afterEach() internal {
        uint64 currentEnd = vault.endTime();
        if (currentEnd < lastEnd) endWentBack = true;
        lastEnd = currentEnd;
        bytes32 active = vault.state().activeRoot;
        if (active != _model.lastSeenActive) {
            if (active == _model.tracked && _model.trackedUnpaused < delay) rootActivatedEarly = true;
            _model.lastSeenActive = active;
        }
    }
}
