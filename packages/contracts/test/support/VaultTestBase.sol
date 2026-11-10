// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {ThuliVault} from "../../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../../src/ThuliVaultFactory.sol";
import {StandardTree} from "./StandardTree.sol";
import {TestToken} from "./TestToken.sol";

/// @notice One vault on a plain token, created through the factory, with the people every test needs.
abstract contract VaultTestBase is Test {
    uint256 internal constant CAP = 100e6;
    uint32 internal constant DELAY = 1 hours;
    uint64 internal constant RUN = 30 days;
    uint256 internal constant START = 1_800_000_000;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");

    ThuliVaultFactory internal factory;
    TestToken internal usd;
    ThuliVault internal vault;
    uint64 internal end;

    function setUp() public virtual {
        vm.warp(START);
        usd = new TestToken();
        factory = new ThuliVaultFactory();
        end = uint64(block.timestamp) + RUN;
        vault = ThuliVault(factory.createVault(address(usd), owner, agent, CAP, end, DELAY));
    }

    function _deposit(uint256 amount) internal {
        usd.mint(owner, amount);
        vm.startPrank(owner);
        usd.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _leaf(address account, uint256 cumulativeAmount) internal view returns (bytes32) {
        return StandardTree.leafHash(block.chainid, address(vault), account, cumulativeAmount);
    }

    function _tree(address[] memory accounts, uint256[] memory amounts) internal view returns (bytes32[] memory) {
        bytes32[] memory leaves = new bytes32[](accounts.length);
        for (uint256 i = 0; i < accounts.length; ++i) {
            leaves[i] = _leaf(accounts[i], amounts[i]);
        }
        return StandardTree.build(leaves);
    }

    /// @dev Alice, Bob and Carol with the given amounts, the usual three-wallet list.
    function _three(uint256 a, uint256 b, uint256 c) internal view returns (bytes32[] memory) {
        address[] memory accounts = new address[](3);
        (accounts[0], accounts[1], accounts[2]) = (alice, bob, carol);
        uint256[] memory amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (a, b, c);
        return _tree(accounts, amounts);
    }

    function _proof(bytes32[] memory tree, address account, uint256 cumulativeAmount)
        internal
        view
        returns (bytes32[] memory)
    {
        return StandardTree.proof(tree, _leaf(account, cumulativeAmount));
    }

    function _post(bytes32[] memory tree, uint256 declaredTotal) internal {
        vm.prank(agent);
        vault.postRoot(StandardTree.root(tree), declaredTotal);
    }

    function _postAndWait(bytes32[] memory tree, uint256 declaredTotal) internal {
        _post(tree, declaredTotal);
        skip(DELAY);
    }

    function _claim(bytes32[] memory tree, address account, uint256 cumulativeAmount) internal {
        vault.claim(account, cumulativeAmount, _proof(tree, account, cumulativeAmount));
    }
}
