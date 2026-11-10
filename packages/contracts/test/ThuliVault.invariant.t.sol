// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: more than one vault at once (the C29 cross-vault case is in ThuliVault.fuzz.t.sol), lists longer
// than five wallets, ownership transfers mid-run, and tokens other than a plain ERC-20.

import {Test} from "forge-std/Test.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";
import {TestToken} from "./support/TestToken.sol";
import {VaultHandler} from "./support/VaultHandler.sol";

contract ThuliVaultInvariantTest is Test {
    uint256 internal constant CAP = 100e6;
    uint32 internal constant DELAY = 1 hours;

    ThuliVault internal vault;
    TestToken internal usd;
    VaultHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new TestToken();
        ThuliVaultFactory factory = new ThuliVaultFactory();
        address owner = makeAddr("owner");
        address[] memory agentKeys = new address[](3);
        (agentKeys[0], agentKeys[1], agentKeys[2]) = (makeAddr("agent"), makeAddr("agent2"), makeAddr("agent3"));
        // A one-week campaign, so most runs live through the end, the withdrawal and the pauses around them.
        vault = ThuliVault(
            factory.createVault(address(usd), owner, agentKeys[0], CAP, uint64(block.timestamp) + 7 days, DELAY)
        );

        address[] memory actors = new address[](5);
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("claimant", vm.toString(i)));
        }
        handler = new VaultHandler(
            VaultHandler.Setup({
                vault: vault,
                usd: usd,
                owner: owner,
                actors: actors,
                agentKeys: agentKeys,
                stranger: makeAddr("stranger")
            })
        );

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.postRoot.selector;
        selectors[2] = VaultHandler.claim.selector;
        selectors[3] = VaultHandler.claim.selector;
        selectors[4] = VaultHandler.claimMoreThanTheLeaf.selector;
        selectors[5] = VaultHandler.cancelRoot.selector;
        selectors[6] = VaultHandler.rotateAgent.selector;
        selectors[7] = VaultHandler.outsiderPostsRoot.selector;
        selectors[8] = VaultHandler.wait.selector;
        selectors[9] = VaultHandler.togglePause.selector;
        selectors[10] = VaultHandler.extendEnd.selector;
        selectors[11] = VaultHandler.withdraw.selector;
        selectors[12] = VaultHandler.donate.selector;
        selectors[13] = VaultHandler.jumpPastEnd.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// C29: total paid never exceeds the deposit.
    function invariantTotalPaidWithinDeposit() public view {
        assertLe(vault.totalPaid(), vault.deposited());
    }

    function invariantClaimedSumsToTotalPaid() public view {
        uint256 sum = 0;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += vault.claimed(handler.actor(i));
        }
        assertEq(sum, vault.totalPaid());
    }

    /// The pool is always whole: what is held plus what was paid covers every deposit. The owner's after-end
    /// withdrawal is counted, and donations sent straight to the vault only ever add to the balance.
    function invariantRewardBalanceCoversDeposits() public view {
        uint256 held = usd.balanceOf(address(vault));
        assertGe(held + vault.totalPaid() + handler.ghostWithdrawn(), vault.deposited());
        assertEq(held + vault.totalPaid() + handler.ghostWithdrawn(), vault.deposited() + handler.ghostDonated());
    }

    /// C27, C30 and C31: no wallet is ever above the cap, and every token a wallet holds came to it as its own claim.
    function invariantNoWalletAboveCap() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            address account = handler.actor(i);
            assertLe(vault.claimed(account), CAP);
            assertEq(usd.balanceOf(account), vault.claimed(account));
        }
        assertEq(usd.balanceOf(handler.stranger()), 0);
    }

    /// C31: the end never moves earlier. The handler also asserts every withdrawal before the end is refused.
    function invariantEndTimeNeverDecreases() public view {
        assertFalse(handler.endWentBack());
        assertGe(vault.endTime(), handler.lastEnd());
    }

    /// C30: only the current agent's postRoot puts a root in place, and the roots match the model at every step. The
    /// handler also asserts that every outsider's postRoot, the old agents' included, is refused with NotAgent.
    function invariantOnlyTheAgentSetsPendingRoot() public view {
        (bytes32 active, bytes32 pending, uint64 pendingAt) = handler.expectedRoots();
        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.activeRoot, active);
        assertEq(s.pendingRoot, pending);
        assertEq(s.pendingClaimableAt, pendingAt);
        assertEq(s.agent, handler.currentAgent());
    }

    /// C30 and C31: a root never becomes active without rootDelay of unpaused time since it was posted, so no pause
    /// can shorten the window in which the owner can cancel it and claimants can still claim under the old root.
    function invariantNoRootActiveBeforeItsUnpausedDelay() public view {
        assertFalse(handler.rootActivatedEarly());
    }
}
