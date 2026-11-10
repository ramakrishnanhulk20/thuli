// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ThuliVault
/// @author Thuli
/// @notice Holds one campaign's reward pool and pays wallets on Thuli's published list, each up to its approved
/// amount, by Merkle proof.
/// @dev One vault per campaign, so a claim can only ever draw on this campaign's deposit (C29). The agent key can
/// only post roots, and every root waits `rootDelay` before it pays, during which the owner can cancel it (C30).
/// Leaves carry cumulative entitlements and the vault pays only the difference from what was already claimed (C27).
/// A pending root whose delay has passed counts as active everywhere, even before a claim records it, so nothing
/// can cancel or replace a root once its delay is over.
contract ThuliVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Everything the frontend shows about a vault, read in one call.
    struct VaultState {
        address token;
        address owner;
        address agent;
        uint256 perWalletCap;
        uint64 endTime;
        uint32 rootDelay;
        uint256 deposited;
        uint256 totalPaid;
        bytes32 activeRoot;
        bytes32 pendingRoot;
        uint64 pendingClaimableAt;
        bool paused;
    }

    /// @notice Shortest root delay a vault accepts. The live demo campaign runs at this floor.
    uint32 public constant MIN_ROOT_DELAY = 1 hours;
    /// @notice Longest root delay a vault accepts.
    uint32 public constant MAX_ROOT_DELAY = 30 days;
    /// @notice How far ahead of now the end time may be set, at creation or by an extension.
    uint64 public constant MAX_END_AHEAD = 365 days;

    /// @notice The reward token. Fee-on-transfer tokens are refused at deposit.
    IERC20 public immutable token;
    /// @notice The most any one wallet can ever receive from this vault, whatever a root says.
    uint256 public immutable perWalletCap;
    /// @notice Seconds a posted root waits before it pays.
    uint32 public immutable rootDelay;

    /// @notice The key allowed to post roots, and nothing else.
    address public agent;
    /// @notice Claims are accepted while block.timestamp is below this, and withdrawal only from it on.
    uint64 public endTime;

    bytes32 private _activeRoot;
    bytes32 private _pendingRoot;
    uint64 private _pendingClaimableAt;
    uint64 private _pausedAt;

    /// @notice Total reward tokens the owner has deposited.
    uint256 public deposited;
    /// @notice Total reward tokens paid to claimants.
    uint256 public totalPaid;
    /// @notice Reward tokens each account has received so far.
    mapping(address account => uint256 amount) public claimed;

    /// @notice The owner added `amount` to the pool.
    /// @param from The owner who paid in.
    /// @param amount Reward tokens added.
    /// @param totalDeposited Everything deposited so far, this deposit included.
    event Deposited(address indexed from, uint256 amount, uint256 totalDeposited);
    /// @notice The agent posted a root that pays from `claimableAt` unless the owner cancels it first.
    /// @param root The new list root.
    /// @param declaredTotal The sum of the list's amounts, as the agent declared it.
    /// @param claimableAt When the root starts paying.
    event RootPosted(bytes32 indexed root, uint256 declaredTotal, uint64 claimableAt);
    /// @notice A pending root was dropped before it could pay: cancelled, replaced, or its agent rotated out.
    /// @param root The dropped root.
    event RootCancelled(bytes32 indexed root);
    /// @notice A pending root finished its delay and was recorded as the root claims prove against.
    /// @param root The root now active.
    event RootActivated(bytes32 indexed root);
    /// @notice The root-posting key changed. Emitted at creation with a zero previous agent.
    /// @param previousAgent The key rotated out.
    /// @param newAgent The key now allowed to post roots.
    event AgentChanged(address indexed previousAgent, address indexed newAgent);
    /// @notice The end time moved later, by an owner extension or by the time spent paused.
    /// @param previousEnd The end time before.
    /// @param newEnd The end time now.
    event EndExtended(uint64 previousEnd, uint64 newEnd);
    /// @notice `account` was paid `amount`.
    /// @param account The wallet in the leaf, which received the payment.
    /// @param amount Reward tokens sent in this claim.
    /// @param cumulative Everything the account has received from this vault, this claim included.
    event Claimed(address indexed account, uint256 amount, uint256 cumulative);
    /// @notice The owner took back what was left after the end.
    /// @param to Where the rewards went.
    /// @param amount Reward tokens sent.
    event Withdrawn(address indexed to, uint256 amount);
    /// @notice The owner returned a token that was not the reward token.
    /// @param token The rescued token.
    /// @param to Where it went.
    /// @param amount How much was sent.
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error AgentIsOwner();
    error ZeroCap();
    error EndTimeOutOfRange(uint64 endTime);
    error RootDelayOutOfRange(uint32 rootDelay);
    error ZeroAmount();
    error CampaignEnded();
    error CampaignNotEnded();
    error FeeOnTransferToken(uint256 expected, uint256 received);
    error NotAgent(address caller);
    error ZeroRoot();
    error DeclaredTotalAboveDeposit(uint256 declaredTotal, uint256 deposited);
    error NoPendingRoot();
    error RootAlreadyClaimable(uint64 claimableAt);
    error NoClaimableRoot();
    error InvalidProof();
    error NothingToClaim(address account);
    error DepositExhausted(uint256 amount, uint256 available);
    error NothingToWithdraw();
    error RewardTokenNotRescuable();
    error RenounceDisabled();

    /// @notice Creates a vault for one campaign. Normally called through ThuliVaultFactory.
    /// @param token_ The reward token.
    /// @param owner_ The project running the campaign. Deposits, cancels roots, rotates the agent, withdraws after end.
    /// @param agent_ Thuli's root-posting key. Must differ from the owner.
    /// @param perWalletCap_ The most one wallet can ever receive. Must be above zero.
    /// @param endTime_ When claims stop. Must be in the future and at most 365 days from now.
    /// @param rootDelay_ Seconds every root waits before it pays, from 1 hour to 30 days.
    /// @dev Reverts with OwnableInvalidOwner for a zero owner, ZeroAddress for a zero token or agent, AgentIsOwner,
    /// ZeroCap, EndTimeOutOfRange or RootDelayOutOfRange. Emits OwnershipTransferred and AgentChanged.
    constructor(
        address token_,
        address owner_,
        address agent_,
        uint256 perWalletCap_,
        uint64 endTime_,
        uint32 rootDelay_
    ) Ownable(owner_) {
        if (token_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (agent_ == owner_) revert AgentIsOwner();
        if (perWalletCap_ == 0) revert ZeroCap();
        if (endTime_ <= block.timestamp || endTime_ > block.timestamp + MAX_END_AHEAD) {
            revert EndTimeOutOfRange(endTime_);
        }
        if (rootDelay_ < MIN_ROOT_DELAY || rootDelay_ > MAX_ROOT_DELAY) revert RootDelayOutOfRange(rootDelay_);

        token = IERC20(token_);
        perWalletCap = perWalletCap_;
        rootDelay = rootDelay_;
        agent = agent_;
        endTime = endTime_;
        emit AgentChanged(address(0), agent_);
    }

    /// @notice Pulls `amount` reward tokens from the owner into the pool.
    /// @dev Owner only, before the end. The owner must have approved this vault first. The balance change is measured
    /// so a token that skims a fee in transit is refused instead of leaving the pool short of what it claims to hold.
    /// Reverts with ZeroAmount, CampaignEnded or FeeOnTransferToken. Emits Deposited.
    /// @param amount Reward tokens to pull, in the token's base units.
    function deposit(uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= endTime) revert CampaignEnded();

        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 newDeposited = deposited + amount;
        deposited = newDeposited;
        emit Deposited(msg.sender, amount, newDeposited);

        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert FeeOnTransferToken(amount, received);
    }

    /// @notice Posts a new list root. It pays only after `rootDelay` seconds, and the owner can cancel it until then.
    /// @dev Agent only, before the end. Replaces a pending root that has not finished its delay, emitting
    /// RootCancelled for it. A pending root whose delay is over becomes active first, so it is never thrown away.
    /// `declaredTotal` is the sum of the list's amounts; refusing one above the deposit catches a list the deposit
    /// cannot cover (C32), while the deposit check in claim is what actually limits payouts (C29).
    /// Reverts with NotAgent, ZeroRoot, CampaignEnded or DeclaredTotalAboveDeposit. Emits RootPosted.
    /// @param root The Merkle root of the published list.
    /// @param declaredTotal The sum of every cumulative amount in the list.
    function postRoot(bytes32 root, uint256 declaredTotal) external {
        if (msg.sender != agent) revert NotAgent(msg.sender);
        if (root == bytes32(0)) revert ZeroRoot();
        if (block.timestamp >= endTime) revert CampaignEnded();
        if (declaredTotal > deposited) revert DeclaredTotalAboveDeposit(declaredTotal, deposited);

        _activatePendingRoot();
        bytes32 replaced = _pendingRoot;
        if (replaced != bytes32(0)) emit RootCancelled(replaced);

        uint64 claimableAt = SafeCast.toUint64(block.timestamp) + rootDelay;
        _pendingRoot = root;
        _pendingClaimableAt = claimableAt;
        emit RootPosted(root, declaredTotal, claimableAt);
    }

    /// @notice Cancels the pending root while it is still inside its delay.
    /// @dev Owner only. This is the owner's defence against a stolen agent key (C30).
    /// Reverts with NoPendingRoot or RootAlreadyClaimable. Emits RootCancelled.
    function cancelRoot() external onlyOwner {
        bytes32 pending = _pendingRoot;
        if (pending == bytes32(0)) revert NoPendingRoot();
        uint64 claimableAt = _pendingClaimableAt;
        if (block.timestamp >= claimableAt) revert RootAlreadyClaimable(claimableAt);
        _clearPendingRoot(pending);
    }

    /// @notice Replaces the agent key. Any root still inside its delay is cancelled in the same call.
    /// @dev Owner only. The key being rotated out may be the stolen one, so nothing it posted is left to mature.
    /// A root whose delay is already over is active and stays. Setting the current agent again is allowed and still
    /// cancels a pending root. Reverts with ZeroAddress or AgentIsOwner. Emits RootCancelled when a pending root is
    /// dropped, and AgentChanged.
    /// @param newAgent The new root-posting key. Must not be zero or the owner.
    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        if (newAgent == owner()) revert AgentIsOwner();

        _activatePendingRoot();
        bytes32 pending = _pendingRoot;
        if (pending != bytes32(0)) _clearPendingRoot(pending);

        address previous = agent;
        agent = newAgent;
        emit AgentChanged(previous, newAgent);
    }

    /// @notice Moves the end time later while the campaign is still running.
    /// @dev Owner only. The end can never move earlier, so the claim window promised to claimants only grows (C31).
    /// An ended campaign stays ended: reopening one after the owner withdrew would leave `deposited` counting money
    /// that has left, so claimable() would promise payouts the vault cannot make. Reverts with CampaignEnded from the
    /// end time on, and EndTimeOutOfRange when `newEnd` is not strictly later than the current end or is more than 365
    /// days from now. Emits EndExtended.
    /// @param newEnd The new end time, in seconds since the epoch.
    function extendEnd(uint64 newEnd) external onlyOwner {
        uint64 previous = endTime;
        if (block.timestamp >= previous) revert CampaignEnded();
        if (newEnd <= previous || newEnd > block.timestamp + MAX_END_AHEAD) revert EndTimeOutOfRange(newEnd);
        endTime = newEnd;
        emit EndExtended(previous, newEnd);
    }

    /// @notice Stops claims and withdrawal until unpaused.
    /// @dev Owner only. Reverts with EnforcedPause when already paused. Emits Paused.
    function pause() external onlyOwner {
        _pause();
        _pausedAt = SafeCast.toUint64(block.timestamp);
    }

    /// @notice Resumes claims and moves the end later by exactly the time spent paused.
    /// @dev Owner only. Without the extension an owner could pause until the end and then withdraw, running out the
    /// claim window (C31). Reverts with ExpectedPause when not paused. Emits Unpaused, and EndExtended when any time
    /// passed while paused.
    function unpause() external onlyOwner {
        _unpause();
        uint64 pausedFor = SafeCast.toUint64(block.timestamp) - _pausedAt;
        _pausedAt = 0;
        if (pausedFor != 0) {
            uint64 previous = endTime;
            uint64 newEnd = previous + pausedFor;
            endTime = newEnd;
            emit EndExtended(previous, newEnd);
        }
    }

    /// @notice Pays `account` what its leaf entitles it to, minus what it has already received.
    /// @dev Anyone may submit, and the tokens always go to `account`, so a relayer cannot redirect a claim (C31).
    /// The leaf binds chain id, this vault, the account and its cumulative amount, double hashed like OpenZeppelin's
    /// StandardMerkleTree (C28). The payout is capped at `perWalletCap` across all roots (C27, C30), and total paid
    /// can never pass the deposit (C29). A pending root whose delay is over is recorded as active first.
    /// Reverts with EnforcedPause, ZeroAddress, CampaignEnded, NoClaimableRoot, InvalidProof, NothingToClaim or
    /// DepositExhausted. Emits RootActivated when it records a root, and Claimed.
    /// @param account The wallet in the leaf, which receives the payment.
    /// @param cumulativeAmount The wallet's total entitlement in the leaf, across all roots so far.
    /// @param proof Sibling hashes from the leaf to the active root.
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        if (account == address(0)) revert ZeroAddress();
        if (block.timestamp >= endTime) revert CampaignEnded();
        _activatePendingRoot();
        bytes32 root = _activeRoot;
        if (root == bytes32(0)) revert NoClaimableRoot();
        if (!MerkleProof.verifyCalldata(proof, root, _leaf(account, cumulativeAmount))) revert InvalidProof();

        uint256 entitled = Math.min(cumulativeAmount, perWalletCap);
        uint256 alreadyClaimed = claimed[account];
        if (entitled <= alreadyClaimed) revert NothingToClaim(account);
        uint256 amount = entitled - alreadyClaimed;
        uint256 paidAfter = totalPaid + amount;
        if (paidAfter > deposited) revert DepositExhausted(amount, deposited - totalPaid);

        claimed[account] = entitled;
        totalPaid = paidAfter;
        emit Claimed(account, amount, entitled);

        token.safeTransfer(account, amount);
    }

    /// @notice Sends every reward token left in the vault to `to` once the campaign has ended.
    /// @dev Owner only, from the end time on, never while paused (C31). Reverts with ZeroAddress, CampaignNotEnded,
    /// EnforcedPause or NothingToWithdraw. Emits Withdrawn.
    /// @param to Where the leftover rewards go.
    function withdrawAfterEnd(address to) external nonReentrant onlyOwner whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp < endTime) revert CampaignNotEnded();
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToWithdraw();
        emit Withdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Returns a token sent here by mistake. The reward token can never leave through this path.
    /// @dev Owner only, at any time. A token reachable through two contract addresses for one balance would get past
    /// the address check; reward tokens with that design are not supported. Reverts with RewardTokenNotRescuable,
    /// ZeroAddress or ZeroAmount. Emits Rescued.
    /// @param otherToken The stuck token.
    /// @param to Where it goes.
    /// @param amount How much to send.
    function rescue(address otherToken, address to, uint256 amount) external nonReentrant onlyOwner {
        if (otherToken == address(token)) revert RewardTokenNotRescuable();
        if (otherToken == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit Rescued(otherToken, to, amount);
        IERC20(otherToken).safeTransfer(to, amount);
    }

    /// @notice Starts an ownership transfer, finished when `newOwner` calls acceptOwnership.
    /// @dev Owner only. Refuses the agent, because one key that could both post and cancel roots would remove the
    /// owner's check on the agent (C30). Reverts with AgentIsOwner. Emits OwnershipTransferStarted.
    /// @param newOwner The proposed owner. Zero cancels a transfer in progress.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == agent) revert AgentIsOwner();
        super.transferOwnership(newOwner);
    }

    /// @notice Disabled. A vault without an owner could never cancel a bad root or return leftovers.
    /// @dev Always reverts with RenounceDisabled.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice The vault's full state in one read, with a root whose delay is over shown as the active root.
    /// @return s Token, owner, agent, cap, end time, delay, deposited, paid, active and pending roots, when the
    /// pending root becomes claimable (zero when there is none), and whether the vault is paused.
    function state() external view returns (VaultState memory s) {
        (bytes32 active, bytes32 pending, uint64 pendingAt) = _effectiveRoots();
        s = VaultState({
            token: address(token),
            owner: owner(),
            agent: agent,
            perWalletCap: perWalletCap,
            endTime: endTime,
            rootDelay: rootDelay,
            deposited: deposited,
            totalPaid: totalPaid,
            activeRoot: active,
            pendingRoot: pending,
            pendingClaimableAt: pendingAt,
            paused: paused()
        });
    }

    /// @notice What a claim with a valid proof for (`account`, `cumulativeAmount`) would pay right now.
    /// @dev Does not check the proof: pass the amount from the account's leaf. Returns zero whenever the claim would
    /// revert for a reason other than the proof: paused, ended, no claimable root, nothing new, or not enough deposit.
    /// @param account The wallet in the leaf.
    /// @param cumulativeAmount The cumulative amount in the leaf.
    /// @return The reward tokens the claim would send to `account`.
    function claimable(address account, uint256 cumulativeAmount) external view returns (uint256) {
        if (account == address(0) || paused() || block.timestamp >= endTime) return 0;
        (bytes32 active,,) = _effectiveRoots();
        if (active == bytes32(0)) return 0;
        uint256 entitled = Math.min(cumulativeAmount, perWalletCap);
        uint256 alreadyClaimed = claimed[account];
        if (entitled <= alreadyClaimed) return 0;
        uint256 amount = entitled - alreadyClaimed;
        if (amount > deposited - totalPaid) return 0;
        return amount;
    }

    /// @dev Blocks the agent from ever accepting ownership, including a transfer started before it became the agent.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == agent) revert AgentIsOwner();
        super._transferOwnership(newOwner);
    }

    function _activatePendingRoot() private {
        bytes32 pending = _pendingRoot;
        if (pending != bytes32(0) && block.timestamp >= _pendingClaimableAt) {
            _activeRoot = pending;
            _pendingRoot = bytes32(0);
            _pendingClaimableAt = 0;
            emit RootActivated(pending);
        }
    }

    function _clearPendingRoot(bytes32 pending) private {
        _pendingRoot = bytes32(0);
        _pendingClaimableAt = 0;
        emit RootCancelled(pending);
    }

    function _effectiveRoots() private view returns (bytes32 active, bytes32 pending, uint64 pendingClaimableAt) {
        active = _activeRoot;
        pending = _pendingRoot;
        pendingClaimableAt = _pendingClaimableAt;
        if (pending != bytes32(0) && block.timestamp >= pendingClaimableAt) {
            (active, pending, pendingClaimableAt) = (pending, bytes32(0), 0);
        }
    }

    function _leaf(address account, uint256 cumulativeAmount) private view returns (bytes32) {
        // The double hash matches StandardMerkleTree and keeps a 64-byte internal node from ever passing as a leaf.
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), account, cumulativeAmount))));
    }
}
