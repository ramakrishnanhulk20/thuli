// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: Circle blacklisting or pausing USDC (a stated non-goal), gas prices on Base, and anything sent to
// a live network. This runs on a local copy of Base at a pinned block; no transaction leaves this machine. It skips
// when BASE_RPC_URL is not set.

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Test} from "forge-std/Test.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";
import {StandardTree} from "./support/StandardTree.sol";

contract ThuliVaultForkTest is Test {
    IERC20Metadata internal constant USDC = IERC20Metadata(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    uint256 internal constant FORK_BLOCK = 55_661_700;
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant CAP = 5e6;
    uint32 internal constant DELAY = 1 hours;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");

    bool internal forked;

    function setUp() public {
        if (bytes(vm.envOr("BASE_RPC_URL", string(""))).length == 0) return;
        vm.createSelectFork("base", FORK_BLOCK);
        forked = true;
    }

    function testForkFullCampaignOnRealBaseUsdc() public {
        vm.skip(!forked);
        assertEq(block.chainid, BASE_CHAIN_ID);
        assertEq(USDC.symbol(), "USDC");
        assertEq(USDC.decimals(), 6);

        ThuliVaultFactory factory = new ThuliVaultFactory();
        uint64 end = uint64(vm.getBlockTimestamp()) + 7 days;
        ThuliVault vault = ThuliVault(factory.createVault(address(USDC), owner, agent, CAP, end, DELAY));

        deal(address(USDC), owner, 20e6);
        vm.startPrank(owner);
        USDC.approve(address(vault), 20e6);
        vault.deposit(20e6);
        vm.stopPrank();
        assertEq(USDC.balanceOf(address(vault)), 20e6);
        assertEq(vault.deposited(), 20e6);

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = StandardTree.leafHash(BASE_CHAIN_ID, address(vault), alice, 5e6);
        leaves[1] = StandardTree.leafHash(BASE_CHAIN_ID, address(vault), bob, 3e6);
        leaves[2] = StandardTree.leafHash(BASE_CHAIN_ID, address(vault), carol, 7e6);
        bytes32[] memory tree = StandardTree.build(leaves);
        vm.prank(agent);
        vault.postRoot(StandardTree.root(tree), 15e6);

        vm.expectRevert(ThuliVault.NoClaimableRoot.selector);
        vault.claim(alice, 5e6, StandardTree.proof(tree, leaves[0]));
        skip(DELAY);

        vm.prank(alice);
        vault.claim(alice, 5e6, StandardTree.proof(tree, leaves[0]));
        vm.prank(relayer);
        vault.claim(bob, 3e6, StandardTree.proof(tree, leaves[1]));
        vault.claim(carol, 7e6, StandardTree.proof(tree, leaves[2]));

        assertEq(USDC.balanceOf(alice), 5e6);
        assertEq(USDC.balanceOf(bob), 3e6);
        assertEq(USDC.balanceOf(carol), CAP);
        assertEq(USDC.balanceOf(relayer), 0);
        assertEq(vault.totalPaid(), 13e6);

        vm.prank(owner);
        vm.expectRevert(ThuliVault.CampaignNotEnded.selector);
        vault.withdrawAfterEnd(owner);
        vm.warp(end);
        vm.prank(owner);
        vault.withdrawAfterEnd(owner);
        assertEq(USDC.balanceOf(owner), 7e6);
        assertEq(USDC.balanceOf(address(vault)), 0);
    }
}
