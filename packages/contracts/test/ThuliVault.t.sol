// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: random amounts, trees and timings (ThuliVault.fuzz.t.sol), long random call sequences
// (ThuliVault.invariant.t.sol), real USDC on Base (ThuliVault.fork.t.sol) and the 30-wallet demo (ThuliVault.demo.t.sol).

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Vm} from "forge-std/Vm.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";
import {FeeToken} from "./support/FeeToken.sol";
import {ReentrantToken} from "./support/ReentrantToken.sol";
import {StandardTree} from "./support/StandardTree.sol";
import {TestToken} from "./support/TestToken.sol";
import {VaultTestBase} from "./support/VaultTestBase.sol";

contract ThuliVaultTest is VaultTestBase {
    function testCreateVaultEmitsAndRecordsSettings() public {
        uint64 newEnd = uint64(block.timestamp) + 7 days;
        address expected = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.expectEmit(true, true, false, false, expected);
        emit Ownable.OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, true, false, false, expected);
        emit ThuliVault.AgentChanged(address(0), agent);
        vm.expectEmit(true, true, true, true, address(factory));
        emit ThuliVaultFactory.VaultCreated(expected, owner, agent, address(usd), CAP, newEnd, DELAY);
        ThuliVault created = ThuliVault(factory.createVault(address(usd), owner, agent, CAP, newEnd, DELAY));

        assertEq(address(created), expected);
        ThuliVault.VaultState memory s = created.state();
        assertEq(s.token, address(usd));
        assertEq(s.owner, owner);
        assertEq(s.agent, agent);
        assertEq(s.perWalletCap, CAP);
        assertEq(s.endTime, newEnd);
        assertEq(s.rootDelay, DELAY);
        assertEq(s.deposited, 0);
        assertEq(s.totalPaid, 0);
        assertEq(s.activeRoot, bytes32(0));
        assertEq(s.pendingRoot, bytes32(0));
        assertEq(s.pendingClaimableAt, 0);
        assertFalse(s.paused);
    }

    function testCreateVaultRevertsOnZeroAddresses() public {
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        factory.createVault(address(0), owner, agent, CAP, end, DELAY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        factory.createVault(address(usd), address(0), agent, CAP, end, DELAY);
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        factory.createVault(address(usd), owner, address(0), CAP, end, DELAY);
    }

    function testCreateVaultRevertsWhenAgentIsOwner() public {
        vm.expectRevert(ThuliVault.AgentIsOwner.selector);
        factory.createVault(address(usd), owner, owner, CAP, end, DELAY);
    }

    function testCreateVaultRevertsOnZeroCap() public {
        vm.expectRevert(ThuliVault.ZeroCap.selector);
        factory.createVault(address(usd), owner, agent, 0, end, DELAY);
    }

    function testCreateVaultEndTimeBounds() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 yearOut = nowTs + 365 days;
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.EndTimeOutOfRange.selector, nowTs));
        factory.createVault(address(usd), owner, agent, CAP, nowTs, DELAY);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.EndTimeOutOfRange.selector, yearOut + 1));
        factory.createVault(address(usd), owner, agent, CAP, yearOut + 1, DELAY);
        assertEq(ThuliVault(factory.createVault(address(usd), owner, agent, CAP, nowTs + 1, DELAY)).endTime(), nowTs + 1);
        assertEq(ThuliVault(factory.createVault(address(usd), owner, agent, CAP, yearOut, DELAY)).endTime(), yearOut);
    }

    function testCreateVaultRootDelayBounds() public {
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.RootDelayOutOfRange.selector, uint32(1 hours - 1)));
        factory.createVault(address(usd), owner, agent, CAP, end, 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.RootDelayOutOfRange.selector, uint32(30 days + 1)));
        factory.createVault(address(usd), owner, agent, CAP, end, 30 days + 1);
        assertEq(ThuliVault(factory.createVault(address(usd), owner, agent, CAP, end, 1 hours)).rootDelay(), 1 hours);
        assertEq(ThuliVault(factory.createVault(address(usd), owner, agent, CAP, end, 30 days)).rootDelay(), 30 days);
    }

    function testDepositPullsTokensAndEmits() public {
        usd.mint(owner, 50e6);
        vm.startPrank(owner);
        usd.approve(address(vault), 50e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Deposited(owner, 50e6, 50e6);
        vault.deposit(50e6);
        vm.stopPrank();
        _deposit(10e6);

        assertEq(vault.deposited(), 60e6);
        assertEq(usd.balanceOf(address(vault)), 60e6);
        assertEq(usd.balanceOf(owner), 0);
    }

    function testDepositRevertsOnZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(ThuliVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function testDepositRevertsFromEndTime() public {
        usd.mint(owner, 1e6);
        vm.prank(owner);
        usd.approve(address(vault), 1e6);
        vm.warp(end);
        vm.prank(owner);
        vm.expectRevert(ThuliVault.CampaignEnded.selector);
        vault.deposit(1e6);
    }

    function testDepositRefusesFeeOnTransferToken() public {
        FeeToken feeToken = new FeeToken();
        ThuliVault feeVault = ThuliVault(factory.createVault(address(feeToken), owner, agent, CAP, end, DELAY));
        feeToken.mint(owner, 100e6);
        vm.startPrank(owner);
        feeToken.approve(address(feeVault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.FeeOnTransferToken.selector, 100e6, 99e6));
        feeVault.deposit(100e6);
        vm.stopPrank();
        assertEq(feeVault.deposited(), 0);
    }

    function testPostRootWaitsTheDelay() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        bytes32 root = StandardTree.root(tree);
        uint64 claimableAt = uint64(block.timestamp) + DELAY;

        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.RootPosted(root, 30e6, claimableAt);
        _post(tree, 30e6);
        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.pendingRoot, root);
        assertEq(s.pendingClaimableAt, claimableAt);
        assertEq(s.activeRoot, bytes32(0));

        skip(DELAY - 1);
        vm.expectRevert(ThuliVault.NoClaimableRoot.selector);
        _claim(tree, alice, 10e6);
        skip(1);
        _claim(tree, alice, 10e6);
        assertEq(usd.balanceOf(alice), 10e6);
    }

    function testPostRootRevertsForAnyoneButAgent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NotAgent.selector, owner));
        vault.postRoot(bytes32(uint256(1)), 0);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NotAgent.selector, relayer));
        vault.postRoot(bytes32(uint256(1)), 0);
    }

    function testPostRootRevertsOnZeroRoot() public {
        vm.prank(agent);
        vm.expectRevert(ThuliVault.ZeroRoot.selector);
        vault.postRoot(bytes32(0), 0);
    }

    function testPostRootRevertsFromEndTime() public {
        vm.warp(end);
        vm.prank(agent);
        vm.expectRevert(ThuliVault.CampaignEnded.selector);
        vault.postRoot(bytes32(uint256(1)), 0);
    }

    function testPostRootRevertsWhenDeclaredTotalAboveDeposit() public {
        _deposit(10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.DeclaredTotalAboveDeposit.selector, 10e6 + 1, 10e6));
        vault.postRoot(bytes32(uint256(1)), 10e6 + 1);
    }

    function testPostRootReplacesARootStillWaiting() public {
        _deposit(30e6);
        bytes32[] memory first = _three(10e6, 10e6, 10e6);
        bytes32[] memory second = _three(5e6, 5e6, 5e6);
        _post(first, 30e6);
        skip(DELAY / 2);

        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootCancelled(StandardTree.root(first));
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.RootPosted(StandardTree.root(second), 15e6, uint64(block.timestamp) + DELAY);
        _post(second, 15e6);

        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.pendingRoot, StandardTree.root(second));
        assertEq(s.pendingClaimableAt, uint64(block.timestamp) + DELAY);
        assertEq(s.activeRoot, bytes32(0));
    }

    function testPostRootKeepsARootWhoseDelayIsOver() public {
        _deposit(30e6);
        bytes32[] memory first = _three(10e6, 10e6, 10e6);
        bytes32[] memory second = _three(10e6, 20e6, 0);
        _postAndWait(first, 30e6);

        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootActivated(StandardTree.root(first));
        _post(second, 30e6);

        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.activeRoot, StandardTree.root(first));
        assertEq(s.pendingRoot, StandardTree.root(second));
        _claim(first, carol, 10e6);
        assertEq(usd.balanceOf(carol), 10e6);
    }

    function testCancelRootStopsItForever() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _post(tree, 30e6);

        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootCancelled(StandardTree.root(tree));
        vm.prank(owner);
        vault.cancelRoot();

        skip(DELAY * 2);
        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.pendingRoot, bytes32(0));
        assertEq(s.activeRoot, bytes32(0));
        vm.expectRevert(ThuliVault.NoClaimableRoot.selector);
        _claim(tree, alice, 10e6);
    }

    function testCancelRootRevertsWithoutAPendingRoot() public {
        vm.prank(owner);
        vm.expectRevert(ThuliVault.NoPendingRoot.selector);
        vault.cancelRoot();
    }

    function testCancelRootRevertsOnceTheDelayIsOver() public {
        _deposit(30e6);
        _post(_three(10e6, 10e6, 10e6), 30e6);
        uint64 claimableAt = uint64(vm.getBlockTimestamp()) + DELAY;
        skip(DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.RootAlreadyClaimable.selector, claimableAt));
        vault.cancelRoot();
    }

    function testSetAgentRotatesTheKeyAndDropsItsPendingRoot() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _post(tree, 30e6);
        address newAgent = makeAddr("newAgent");

        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootCancelled(StandardTree.root(tree));
        vm.expectEmit(true, true, false, false, address(vault));
        emit ThuliVault.AgentChanged(agent, newAgent);
        vm.prank(owner);
        vault.setAgent(newAgent);

        assertEq(vault.agent(), newAgent);
        assertEq(vault.state().pendingRoot, bytes32(0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NotAgent.selector, agent));
        vault.postRoot(StandardTree.root(tree), 30e6);
        vm.prank(newAgent);
        vault.postRoot(StandardTree.root(tree), 30e6);
        assertEq(vault.state().pendingRoot, StandardTree.root(tree));
    }

    function testSetAgentKeepsARootWhoseDelayIsOver() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootActivated(StandardTree.root(tree));
        vm.prank(owner);
        vault.setAgent(makeAddr("newAgent"));
        assertEq(vault.state().activeRoot, StandardTree.root(tree));
        _claim(tree, bob, 10e6);
        assertEq(usd.balanceOf(bob), 10e6);
    }

    function testSetAgentRevertsOnZeroOrOwner() public {
        vm.startPrank(owner);
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        vault.setAgent(address(0));
        vm.expectRevert(ThuliVault.AgentIsOwner.selector);
        vault.setAgent(owner);
        vm.stopPrank();
    }

    /// C30 and C31, ported from review: an owner with a sock agent posts a list of mules, then pauses through the
    /// delay. The delay must still run for its full length of unpaused time, cancellable, with the old root paying.
    function testPauseNeverRunsOutARootDelay() public {
        _deposit(300e6);
        bytes32[] memory honest = _three(100e6, 100e6, 100e6);
        _postAndWait(honest, 300e6);
        address[] memory mules = new address[](3);
        (mules[0], mules[1], mules[2]) = (makeAddr("m0"), makeAddr("m1"), makeAddr("m2"));
        uint256[] memory amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (100e6, 100e6, 100e6);
        bytes32[] memory bad = _tree(mules, amounts);

        address sock = makeAddr("sock");
        vm.prank(owner);
        vault.setAgent(sock);
        vm.prank(sock);
        vault.postRoot(StandardTree.root(bad), 300e6);
        uint64 postedAt = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        vault.pause();
        skip(DELAY);
        vm.prank(owner);
        vault.unpause();

        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.activeRoot, StandardTree.root(honest));
        assertEq(s.pendingRoot, StandardTree.root(bad));
        assertEq(s.pendingClaimableAt, postedAt + 2 * DELAY);
        _claim(honest, alice, 100e6);
        assertEq(usd.balanceOf(alice), 100e6);
        skip(DELAY - 1);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        _claim(bad, mules[0], 100e6);
        vm.prank(owner);
        vault.cancelRoot();
        skip(DELAY);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        _claim(bad, mules[0], 100e6);
        assertEq(vault.state().activeRoot, StandardTree.root(honest));
    }

    function testPostRootRevertsWhilePaused() public {
        vm.prank(owner);
        vault.pause();
        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.postRoot(bytes32(uint256(1)), 0);
    }

    function testPostRootRefusesARootThatCouldNotPayBeforeTheEnd() public {
        vm.warp(end - DELAY);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.RootWouldNotActivate.selector, end, end));
        vault.postRoot(bytes32(uint256(1)), 0);
        vm.warp(end - DELAY - 1);
        vm.prank(agent);
        vault.postRoot(bytes32(uint256(1)), 0);
        assertEq(vault.state().pendingClaimableAt, end - 1);
    }

    function testPauseRecordsARootWhoseDelayFinishedFirst() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootActivated(StandardTree.root(tree));
        vm.startPrank(owner);
        vault.pause();
        vault.setAgent(makeAddr("newAgent"));
        vault.unpause();
        vm.stopPrank();
        assertEq(vault.state().activeRoot, StandardTree.root(tree));
        _claim(tree, alice, 10e6);
        assertEq(usd.balanceOf(alice), 10e6);
    }

    function testUnpauseMovesThePendingRootByTheTimePaused() public {
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _post(tree, 0);
        uint64 postedAt = uint64(vm.getBlockTimestamp());
        skip(10 minutes);
        vm.prank(owner);
        vault.pause();
        skip(1 days);
        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.pendingRoot, StandardTree.root(tree));
        assertEq(s.pendingClaimableAt, postedAt + DELAY + 1 days);
        assertEq(vault.claimable(alice, 10e6), 0);

        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.RootDelayed(StandardTree.root(tree), postedAt + DELAY + 1 days);
        vm.prank(owner);
        vault.unpause();
        assertEq(vault.state().pendingClaimableAt, postedAt + DELAY + 1 days);
        skip(DELAY - 10 minutes - 1);
        assertEq(vault.state().activeRoot, bytes32(0));
        skip(1);
        assertEq(vault.state().activeRoot, StandardTree.root(tree));
    }

    function testStateWhilePausedWithNoPendingRoot() public {
        vm.prank(owner);
        vault.pause();
        skip(1 days);
        assertEq(vault.state().pendingClaimableAt, 0);
        vm.prank(owner);
        vm.expectRevert(ThuliVault.NoPendingRoot.selector);
        vault.cancelRoot();
    }

    function testExtendEndMovesTheEndLater() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit ThuliVault.EndExtended(end, end + 1 days);
        vm.prank(owner);
        vault.extendEnd(end + 1 days);
        assertEq(vault.endTime(), end + 1 days);
    }

    function testExtendEndRevertsUnlessLaterAndWithinAYear() public {
        uint64 yearOut = uint64(block.timestamp) + 365 days;
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.EndTimeOutOfRange.selector, end));
        vault.extendEnd(end);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.EndTimeOutOfRange.selector, end - 1));
        vault.extendEnd(end - 1);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.EndTimeOutOfRange.selector, yearOut + 1));
        vault.extendEnd(yearOut + 1);
        vault.extendEnd(yearOut);
        vm.stopPrank();
        assertEq(vault.endTime(), yearOut);
    }

    function testExtendEndCannotReopenAnEndedCampaign() public {
        _deposit(30e6);
        vm.warp(end);
        vm.startPrank(owner);
        vault.withdrawAfterEnd(owner);
        vm.expectRevert(ThuliVault.CampaignEnded.selector);
        vault.extendEnd(end + 1 days);
        vm.stopPrank();
        assertEq(vault.endTime(), end);
    }

    function testPauseStopsClaimsAndWithdrawal() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        vm.expectEmit(false, false, false, true, address(vault));
        emit Pausable.Paused(owner);
        vm.prank(owner);
        vault.pause();

        assertTrue(vault.state().paused);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _claim(tree, alice, 10e6);
        vm.warp(end);
        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.withdrawAfterEnd(owner);
    }

    function testUnpauseMovesTheEndByTheTimePaused() public {
        vm.prank(owner);
        vault.pause();
        skip(5 days);
        vm.expectEmit(false, false, false, true, address(vault));
        emit Pausable.Unpaused(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit ThuliVault.EndExtended(end, end + 5 days);
        vm.prank(owner);
        vault.unpause();
        assertEq(vault.endTime(), end + 5 days);
        assertFalse(vault.paused());
    }

    function testUnpauseInTheSameSecondLeavesTheEndAlone() public {
        vm.startPrank(owner);
        vault.pause();
        vm.recordLogs();
        vault.unpause();
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Pausable.Unpaused.selector);
        assertEq(vault.endTime(), end);
    }

    function testPauseAndUnpauseRejectTheWrongState() public {
        vm.startPrank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vault.unpause();
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pause();
        vm.stopPrank();
    }

    function testClaimPaysTheLeafAccountWhoeverSubmits() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 5e6, 15e6);
        _postAndWait(tree, 30e6);

        vm.expectEmit(true, false, false, false, address(vault));
        emit ThuliVault.RootActivated(StandardTree.root(tree));
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Claimed(alice, 10e6, 10e6);
        vm.prank(relayer);
        _claim(tree, alice, 10e6);

        assertEq(usd.balanceOf(alice), 10e6);
        assertEq(usd.balanceOf(relayer), 0);
        assertEq(vault.claimed(alice), 10e6);
        assertEq(vault.totalPaid(), 10e6);
        assertEq(usd.balanceOf(address(vault)), 20e6);
    }

    function testClaimRevertsBeforeAnyRoot() public {
        _deposit(30e6);
        vm.expectRevert(ThuliVault.NoClaimableRoot.selector);
        vault.claim(alice, 10e6, new bytes32[](0));
    }

    function testClaimKeepsTheOldRootWhileANewOneWaits() public {
        _deposit(40e6);
        bytes32[] memory first = _three(10e6, 10e6, 10e6);
        bytes32[] memory second = _three(10e6, 20e6, 10e6);
        _postAndWait(first, 30e6);
        _post(second, 40e6);

        _claim(first, bob, 10e6);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        _claim(second, bob, 20e6);
        skip(DELAY);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Claimed(bob, 10e6, 20e6);
        _claim(second, bob, 20e6);
        assertEq(usd.balanceOf(bob), 20e6);
    }

    function testClaimRevertsOnAWrongProof() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        bytes32[] memory aliceProof = _proof(tree, alice, 10e6);

        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(alice, 10e6 + 1, aliceProof);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(relayer, 10e6, aliceProof);
        vm.expectRevert(ThuliVault.InvalidProof.selector);
        vault.claim(alice, 10e6, new bytes32[](0));
    }

    function testClaimRevertsWhenNothingNewIsOwed() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        _claim(tree, alice, 10e6);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, alice));
        _claim(tree, alice, 10e6);
    }

    function testClaimRevertsFromEndTime() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        vm.warp(end);
        vm.expectRevert(ThuliVault.CampaignEnded.selector);
        _claim(tree, alice, 10e6);
    }

    function testClaimRevertsForTheZeroAddress() public {
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        vault.claim(address(0), 1, new bytes32[](0));
    }

    function testClaimStopsAtTheDeposit() public {
        _deposit(15e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 15e6);
        _claim(tree, alice, 10e6);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.DepositExhausted.selector, 10e6, 5e6));
        _claim(tree, bob, 10e6);
        assertEq(vault.totalPaid(), 10e6);
    }

    function testClaimNeverPaysAboveTheCap() public {
        _deposit(CAP * 3);
        bytes32[] memory tree = _three(CAP * 3, 1, 1);
        _postAndWait(tree, CAP * 3);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Claimed(alice, CAP, CAP);
        _claim(tree, alice, CAP * 3);
        assertEq(usd.balanceOf(alice), CAP);

        bytes32[] memory raised = _three(CAP * 5, 1, 1);
        _postAndWait(raised, CAP * 3);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, alice));
        _claim(raised, alice, CAP * 5);
    }

    function testClaimBlocksReentryFromTheToken() public {
        ReentrantToken hostile = new ReentrantToken();
        ThuliVault target = ThuliVault(factory.createVault(address(hostile), owner, agent, CAP, end, DELAY));
        hostile.mint(owner, 20e6);
        vm.startPrank(owner);
        hostile.approve(address(target), 20e6);
        target.deposit(20e6);
        vm.stopPrank();

        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = StandardTree.leafHash(block.chainid, address(target), alice, 10e6);
        leaves[1] = StandardTree.leafHash(block.chainid, address(target), bob, 10e6);
        bytes32[] memory tree = StandardTree.build(leaves);
        vm.prank(agent);
        target.postRoot(StandardTree.root(tree), 20e6);
        skip(DELAY);

        bytes32[] memory aliceProof = StandardTree.proof(tree, leaves[0]);
        hostile.arm(target, 10e6, aliceProof);
        target.claim(alice, 10e6, aliceProof);

        assertTrue(hostile.reentered());
        assertFalse(hostile.reentrySucceeded());
        assertEq(hostile.reentryError(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(hostile.balanceOf(alice), 10e6);
        assertEq(target.totalPaid(), 10e6);
    }

    function testWithdrawAfterEndSendsEverythingLeft() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _postAndWait(tree, 30e6);
        _claim(tree, alice, 10e6);
        vm.warp(end);

        vm.expectEmit(true, false, false, true, address(vault));
        emit ThuliVault.Withdrawn(owner, 20e6);
        vm.prank(owner);
        vault.withdrawAfterEnd(owner);
        assertEq(usd.balanceOf(owner), 20e6);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function testWithdrawRevertsBeforeTheEnd() public {
        _deposit(30e6);
        vm.warp(end - 1);
        vm.prank(owner);
        vm.expectRevert(ThuliVault.CampaignNotEnded.selector);
        vault.withdrawAfterEnd(owner);
    }

    function testWithdrawRevertsOnZeroRecipientOrEmptyVault() public {
        vm.warp(end);
        vm.startPrank(owner);
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        vault.withdrawAfterEnd(address(0));
        vm.expectRevert(ThuliVault.NothingToWithdraw.selector);
        vault.withdrawAfterEnd(owner);
        vm.stopPrank();
    }

    function testRescueReturnsAnotherToken() public {
        TestToken stray = new TestToken();
        stray.mint(address(vault), 7e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ThuliVault.Rescued(address(stray), owner, 7e6);
        vm.prank(owner);
        vault.rescue(address(stray), owner, 7e6);
        assertEq(stray.balanceOf(owner), 7e6);
    }

    function testRescueNeverTouchesTheRewardToken() public {
        _deposit(30e6);
        vm.prank(owner);
        vm.expectRevert(ThuliVault.RewardTokenNotRescuable.selector);
        vault.rescue(address(usd), owner, 1);
        assertEq(usd.balanceOf(address(vault)), 30e6);
    }

    function testRescueRejectsBadInput() public {
        TestToken stray = new TestToken();
        vm.startPrank(owner);
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        vault.rescue(address(0), owner, 1);
        vm.expectRevert(ThuliVault.ZeroAddress.selector);
        vault.rescue(address(stray), address(0), 1);
        vm.expectRevert(ThuliVault.ZeroAmount.selector);
        vault.rescue(address(stray), owner, 0);
        vm.stopPrank();
    }

    function testOwnershipMovesInTwoSteps() public {
        address newOwner = makeAddr("newOwner");
        vm.expectEmit(true, true, false, false, address(vault));
        emit Ownable2Step.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), owner);

        vm.expectEmit(true, true, false, false, address(vault));
        emit Ownable.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vault.pause();
    }

    function testAgentCanNeverBecomeOwner() public {
        vm.prank(owner);
        vm.expectRevert(ThuliVault.AgentIsOwner.selector);
        vault.transferOwnership(agent);

        vm.startPrank(owner);
        vault.transferOwnership(bob);
        vault.setAgent(bob);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(ThuliVault.AgentIsOwner.selector);
        vault.acceptOwnership();
        assertEq(vault.owner(), owner);
    }

    function testRenounceOwnershipIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(ThuliVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }

    /// C30: the agent key reaches nothing but postRoot.
    function testAgentKeyCanOnlyPostRoots() public {
        bytes memory refused = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent);
        vm.startPrank(agent);
        vm.expectRevert(refused);
        vault.deposit(1);
        vm.expectRevert(refused);
        vault.cancelRoot();
        vm.expectRevert(refused);
        vault.setAgent(bob);
        vm.expectRevert(refused);
        vault.extendEnd(end + 1);
        vm.expectRevert(refused);
        vault.pause();
        vm.expectRevert(refused);
        vault.unpause();
        vm.expectRevert(refused);
        vault.withdrawAfterEnd(agent);
        vm.expectRevert(refused);
        vault.rescue(address(usd), agent, 1);
        vm.expectRevert(refused);
        vault.transferOwnership(agent);
        vm.stopPrank();
    }

    function testStateShowsAFinishedDelayAsActive() public {
        _deposit(30e6);
        bytes32[] memory tree = _three(10e6, 10e6, 10e6);
        _post(tree, 30e6);
        assertEq(vault.state().activeRoot, bytes32(0));
        skip(DELAY);
        ThuliVault.VaultState memory s = vault.state();
        assertEq(s.activeRoot, StandardTree.root(tree));
        assertEq(s.pendingRoot, bytes32(0));
        assertEq(s.pendingClaimableAt, 0);
        assertEq(s.deposited, 30e6);
    }

    function testClaimableMatchesWhatAClaimWouldPay() public {
        _deposit(15e6);
        bytes32[] memory tree = _three(10e6, 10e6, CAP * 2);
        assertEq(vault.claimable(alice, 10e6), 0);
        _postAndWait(tree, 15e6);
        assertEq(vault.claimable(alice, 10e6), 10e6);
        assertEq(vault.claimable(address(0), 10e6), 0);

        _claim(tree, alice, 10e6);
        assertEq(vault.claimable(alice, 10e6), 0);
        assertEq(vault.claimable(bob, 10e6), 0);
        assertEq(vault.claimable(bob, 5e6), 5e6);

        _deposit(CAP * 2);
        assertEq(vault.claimable(carol, CAP * 2), CAP);
        vm.prank(owner);
        vault.pause();
        assertEq(vault.claimable(carol, CAP * 2), 0);
        vm.prank(owner);
        vault.unpause();
        vm.warp(end);
        assertEq(vault.claimable(carol, CAP * 2), 0);
    }
}
