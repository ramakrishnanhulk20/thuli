// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: the signed asks and the screening that decide which wallets get a slot (that is the worker's
// side of C44), and a live network. This runs on a local copy of Base at a pinned block with real USDC, and skips
// when BASE_RPC_URL is not set.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";
import {StandardTree} from "./support/StandardTree.sol";

/// C44: the demo pays at most 20 USDC, 1 USDC each, even when a list of 30 farm wallets reaches the chain.
contract ThuliVaultDemoTest is Test {
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    uint256 internal constant FORK_BLOCK = 55_661_700;
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant POOL = 20e6;
    uint256 internal constant FARM_SIZE = 30;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal farmRelayer = makeAddr("farmRelayer");

    bool internal forked;

    function setUp() public {
        if (bytes(vm.envOr("BASE_RPC_URL", string(""))).length == 0) return;
        vm.createSelectFork("base", FORK_BLOCK);
        forked = true;
    }

    function testDemoPaysAtMostTwentyUsdcOneEach() public {
        vm.skip(!forked);
        ThuliVaultFactory factory = new ThuliVaultFactory();
        ThuliVault vault = ThuliVault(
            factory.createVault(address(USDC), owner, agent, ONE_USDC, uint64(block.timestamp) + 7 days, 1 hours)
        );
        deal(address(USDC), owner, POOL);
        vm.startPrank(owner);
        USDC.approve(address(vault), POOL);
        vault.deposit(POOL);
        vm.stopPrank();

        (address[] memory farm, bytes32[] memory leaves) = _farm(vault, ONE_USDC);
        bytes32[] memory tree = StandardTree.build(leaves);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ThuliVault.DeclaredTotalAboveDeposit.selector, 30e6, POOL));
        vault.postRoot(StandardTree.root(tree), 30e6);

        // A stolen agent key hides the overdraw by declaring only the deposit. The vault has to hold on its own.
        vm.prank(agent);
        vault.postRoot(StandardTree.root(tree), POOL);
        skip(1 hours);

        assertEq(_claimAll(vault, farm, tree, leaves, ONE_USDC), 20);

        (address[] memory raised, bytes32[] memory raisedLeaves) = _farm(vault, 5 * ONE_USDC);
        bytes32[] memory raisedTree = StandardTree.build(raisedLeaves);
        vm.prank(agent);
        vault.postRoot(StandardTree.root(raisedTree), POOL);
        skip(1 hours);
        assertEq(_claimAll(vault, raised, raisedTree, raisedLeaves, 5 * ONE_USDC), 0);

        uint256 paidOut = 0;
        for (uint256 i = 0; i < FARM_SIZE; ++i) {
            assertLe(USDC.balanceOf(farm[i]), ONE_USDC);
            paidOut += USDC.balanceOf(farm[i]);
        }
        assertEq(paidOut, POOL);
        assertEq(vault.totalPaid(), POOL);
        assertEq(USDC.balanceOf(address(vault)), 0);
        assertEq(USDC.balanceOf(farmRelayer), 0);
    }

    /// @dev Every farm wallet claims through one relayer, twice. Past the pool, or a second time, the vault refuses.
    /// Returns how many claims paid.
    function _claimAll(
        ThuliVault vault,
        address[] memory farm,
        bytes32[] memory tree,
        bytes32[] memory leaves,
        uint256 amount
    ) internal returns (uint256 paid) {
        for (uint256 round = 0; round < 2; ++round) {
            for (uint256 i = 0; i < FARM_SIZE; ++i) {
                bytes32[] memory proof = StandardTree.proof(tree, leaves[i]);
                vm.prank(farmRelayer);
                try vault.claim(farm[i], amount, proof) {
                    ++paid;
                } catch (bytes memory reason) {
                    bytes4 selector = bytes4(reason);
                    assertTrue(
                        selector == ThuliVault.DepositExhausted.selector || selector == ThuliVault.NothingToClaim.selector
                    );
                }
            }
        }
    }

    function _farm(ThuliVault vault, uint256 amount)
        internal
        returns (address[] memory farm, bytes32[] memory leaves)
    {
        farm = new address[](FARM_SIZE);
        leaves = new bytes32[](FARM_SIZE);
        for (uint256 i = 0; i < FARM_SIZE; ++i) {
            farm[i] = makeAddr(string.concat("farm", vm.toString(i)));
            leaves[i] = StandardTree.leafHash(block.chainid, address(vault), farm[i], amount);
        }
    }
}
