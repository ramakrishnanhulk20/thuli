// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: long random call sequences (ThuliVault.invariant.t.sol), real USDC on Base
// (ThuliVault.fork.t.sol), and the TypeScript tree builder itself (packages/core/test/leaf.test.ts and the fixture).

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {StandardTree} from "./support/StandardTree.sol";
import {VaultTestBase} from "./support/VaultTestBase.sol";

contract ThuliVaultFuzzTest is VaultTestBase {
    uint256 internal constant MAX_LIST = 16;

    /// C27: claim under root 1, root 2 with the same amount reverts, root 3 with a higher amount pays the difference.
    function testFuzzCumulativeClaimsAcrossThreeRoots(uint256 first, uint256 higher, uint256 bobAmount) public {
        first = bound(first, 1, CAP - 1);
        higher = bound(higher, first + 1, CAP);
        bobAmount = bound(bobAmount, 0, CAP);
        _deposit(3 * CAP);

        bytes32[] memory root1 = _three(first, bobAmount, 1);
        _postAndWait(root1, first + bobAmount + 1);
        _claim(root1, alice, first);
        assertEq(usd.balanceOf(alice), first);

        bytes32[] memory root2 = _three(first, bobAmount, 2);
        _postAndWait(root2, first + bobAmount + 2);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, alice));
        _claim(root2, alice, first);

        bytes32[] memory root3 = _three(higher, bobAmount, 3);
        _postAndWait(root3, higher + bobAmount + 3);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Claimed(alice, higher - first, higher);
        _claim(root3, alice, higher);
        assertEq(usd.balanceOf(alice), higher);
        assertEq(vault.claimed(alice), higher);
        assertEq(vault.totalPaid(), higher);
    }

    /// C27: a later root that lowers or removes a wallet pays it nothing more and takes nothing back.
    function testFuzzLowerOrRemovedWalletKeepsWhatItHas(uint256 first, uint256 lower) public {
        first = bound(first, 1, CAP);
        lower = bound(lower, 0, first);
        _deposit(2 * CAP);
        bytes32[] memory root1 = _three(first, 1, 1);
        _postAndWait(root1, first + 2);
        _claim(root1, alice, first);

        bytes32[] memory lowered = _three(lower, 2, 2);
        _postAndWait(lowered, lower + 4);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, alice));
        _claim(lowered, alice, lower);

        address[] memory others = new address[](2);
        (others[0], others[1]) = (bob, carol);
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (3, 3);
        bytes32[] memory removed = _tree(others, amounts);
        _postAndWait(removed, 6);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(alice, first, _proof(root1, alice, first));

        assertEq(usd.balanceOf(alice), first);
        assertEq(vault.claimed(alice), first);
        assertEq(vault.totalPaid(), first);
    }

    /// C30: whatever amounts the roots carry, one wallet never receives more than the cap.
    function testFuzzCapHoldsWhateverTheRootsSay(uint256 cap, uint256 firstAmount, uint256 secondAmount) public {
        cap = bound(cap, 1, 1e30);
        firstAmount = bound(firstAmount, 1, type(uint256).max);
        secondAmount = bound(secondAmount, firstAmount, type(uint256).max);
        vault = ThuliVault(factory.createVault(address(usd), owner, agent, cap, end, DELAY));
        _deposit(cap);

        bytes32[] memory root1 = _three(firstAmount, 0, 0);
        _postAndWait(root1, cap);
        _claim(root1, alice, firstAmount);
        assertEq(vault.claimed(alice), _min(firstAmount, cap));

        bytes32[] memory root2 = _three(secondAmount, 1, 1);
        _postAndWait(root2, cap);
        if (_min(secondAmount, cap) == _min(firstAmount, cap)) {
            vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, alice));
        }
        _claim(root2, alice, secondAmount);
        assertEq(vault.claimed(alice), _min(secondAmount, cap));
        assertLe(usd.balanceOf(alice), cap);
    }

    /// C28: every proof from a tree laid out like StandardMerkleTree claims on-chain, and pays exactly its leaf.
    function testFuzzEveryProofInARandomListClaims(uint256 seed, uint256 count) public {
        count = bound(count, 1, MAX_LIST);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        bytes32[] memory tree = _tree(accounts, amounts);
        _deposit(total);
        _postAndWait(tree, total);

        for (uint256 i = 0; i < count; ++i) {
            _claim(tree, accounts[i], amounts[i]);
            assertEq(usd.balanceOf(accounts[i]), amounts[i]);
        }
        assertEq(vault.totalPaid(), total);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    /// C28: a real proof with someone else's address in the leaf fails.
    function testFuzzSwappedAccountFails(uint256 seed, uint256 count, uint256 index, address stranger) public {
        count = bound(count, 1, MAX_LIST);
        index = bound(index, 0, count - 1);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        vm.assume(stranger != address(0) && !_contains(accounts, stranger));
        bytes32[] memory tree = _readyTree(accounts, amounts, total);

        bytes32[] memory proof = _proof(tree, accounts[index], amounts[index]);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(stranger, amounts[index], proof);
    }

    /// C28: a real proof with a different amount in the leaf fails.
    function testFuzzSwappedAmountFails(uint256 seed, uint256 count, uint256 index, uint256 wrongAmount) public {
        count = bound(count, 1, MAX_LIST);
        index = bound(index, 0, count - 1);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        vm.assume(wrongAmount != amounts[index]);
        bytes32[] memory tree = _readyTree(accounts, amounts, total);

        bytes32[] memory proof = _proof(tree, accounts[index], amounts[index]);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(accounts[index], wrongAmount, proof);
    }

    /// C28: an internal node with its path to the root fools a bare verifier, but the vault never accepts it, because
    /// the vault hashes the leaf itself from an address and an amount.
    function testFuzzInternalNodeNeverPassesAsALeaf(uint256 seed, uint256 count, uint256 nodeIndex) public {
        count = bound(count, 2, MAX_LIST);
        nodeIndex = bound(nodeIndex, 0, count - 2);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        bytes32[] memory tree = _readyTree(accounts, amounts, total);

        bytes32 node = tree[nodeIndex];
        bytes32[] memory path = StandardTree.proofAt(tree, nodeIndex);
        assertTrue(MerkleProof.verify(path, StandardTree.root(tree), node));

        bytes32 left = tree[2 * nodeIndex + 1];
        bytes32 right = tree[2 * nodeIndex + 2];
        (bytes32 low, bytes32 high) = left < right ? (left, right) : (right, left);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(address(uint160(uint256(low))), uint256(high), path);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(address(uint160(uint256(node))), uint256(node), path);
    }

    /// C28 and C29: a list built for one vault pays nothing from another, and the other vault's deposit is untouched.
    function testFuzzProofForAnotherVaultFails(uint256 seed, uint256 count, uint256 index) public {
        count = bound(count, 1, MAX_LIST);
        index = bound(index, 0, count - 1);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        bytes32[] memory tree = _readyTree(accounts, amounts, total);
        bytes32[] memory proof = _proof(tree, accounts[index], amounts[index]);

        ThuliVault first = vault;
        vault = ThuliVault(factory.createVault(address(usd), owner, agent, CAP, end, DELAY));
        _deposit(total);
        _postAndWait(tree, total);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(accounts[index], amounts[index], proof);

        first.claim(accounts[index], amounts[index], proof);
        assertEq(usd.balanceOf(address(vault)), total);
        assertEq(vault.totalPaid(), 0);
        assertEq(first.totalPaid(), amounts[index]);
    }

    /// C28: a list built for another chain id pays nothing here.
    function testFuzzProofForAnotherChainFails(uint256 seed, uint256 count, uint256 index, uint64 otherChain) public {
        count = bound(count, 1, MAX_LIST);
        index = bound(index, 0, count - 1);
        vm.assume(otherChain != block.chainid && otherChain != 0);
        (address[] memory accounts, uint256[] memory amounts, uint256 total) = _randomList(seed, count);
        bytes32[] memory leaves = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            leaves[i] = StandardTree.leafHash(otherChain, address(vault), accounts[i], amounts[i]);
        }
        bytes32[] memory tree = StandardTree.build(leaves);
        _deposit(total);
        _postAndWait(tree, total);

        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(accounts[index], amounts[index], StandardTree.proof(tree, leaves[index]));
    }

    /// C31: whoever submits the claim, the tokens go to the address in the leaf and nowhere else.
    function testFuzzAnySubmitterPaysTheLeafAccount(address submitter, uint256 amount) public {
        vm.assume(submitter != alice && submitter != address(vault));
        amount = bound(amount, 1, CAP);
        _deposit(amount + 2);
        bytes32[] memory tree = _three(amount, 1, 1);
        _postAndWait(tree, amount + 2);
        uint256 submitterBefore = usd.balanceOf(submitter);

        vm.prank(submitter);
        _claim(tree, alice, amount);
        assertEq(usd.balanceOf(alice), amount);
        assertEq(usd.balanceOf(submitter), submitterBefore);
    }

    /// C31: a pause of any length, before or after the end, moves the end later by exactly that length, so the
    /// time left to claim when the pause began is the time left when it lifts.
    function testFuzzPauseExtendsTheEndExactly(uint256 pauseAfter, uint256 duration) public {
        pauseAfter = bound(pauseAfter, 0, 2 * RUN);
        duration = bound(duration, 0, 3650 days);
        _deposit(1e6);
        skip(pauseAfter);
        uint256 pausedAt = vm.getBlockTimestamp();

        vm.prank(owner);
        vault.pause();
        skip(duration);
        vm.prank(owner);
        vault.unpause();

        assertEq(vault.endTime(), end + duration);
        if (pausedAt < end) {
            assertEq(vault.endTime() - block.timestamp, end - pausedAt);
            vm.prank(owner);
            vm.expectRevert(ThuliVault.CampaignNotEnded.selector);
            vault.withdrawAfterEnd(owner);
        }
    }

    function _readyTree(address[] memory accounts, uint256[] memory amounts, uint256 total)
        internal
        returns (bytes32[] memory tree)
    {
        tree = _tree(accounts, amounts);
        _deposit(total);
        _postAndWait(tree, total);
    }

    function _randomList(uint256 seed, uint256 count)
        internal
        pure
        returns (address[] memory accounts, uint256[] memory amounts, uint256 total)
    {
        accounts = new address[](count);
        amounts = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            accounts[i] = address(uint160(uint256(keccak256(abi.encode(seed, "account", i)))));
            amounts[i] = uint256(keccak256(abi.encode(seed, "amount", i))) % CAP + 1;
            total += amounts[i];
        }
    }

    function _contains(address[] memory accounts, address candidate) internal pure returns (bool) {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == candidate) return true;
        }
        return false;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
