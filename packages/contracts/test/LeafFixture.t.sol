// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Not covered here: random lists (ThuliVault.fuzz.t.sol builds those with the same StandardTree). This file pins one
// list in test/fixtures/leaf-tree.json so packages/core/test/leaf.test.ts can check the TypeScript builder, which uses
// the real @openzeppelin/merkle-tree, against it. Regenerate the file with:
//   WRITE_LEAF_FIXTURE=true forge test --match-contract LeafFixtureTest

import {Test} from "forge-std/Test.sol";
import {ThuliVault} from "../src/ThuliVault.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";
import {StandardTree} from "./support/StandardTree.sol";
import {TestToken} from "./support/TestToken.sol";

contract LeafFixtureTest is Test {
    string internal constant PATH = "test/fixtures/leaf-tree.json";
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant CAP = 200e6;
    uint256 internal constant COUNT = 7;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");

    /// C28: the pinned list, its root and every proof are what StandardTree builds, and each proof pays on-chain.
    function testFixtureMatchesStandardTreeAndPaysOnChain() public {
        vm.chainId(BASE_CHAIN_ID);
        ThuliVaultFactory factory = _factoryAtFixedAddress();
        address vaultAt = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        (address[] memory accounts, uint256[] memory amounts) = _list();
        bytes32[] memory leaves = new bytes32[](COUNT);
        for (uint256 i = 0; i < COUNT; ++i) {
            leaves[i] = StandardTree.leafHash(BASE_CHAIN_ID, vaultAt, accounts[i], amounts[i]);
        }
        bytes32[] memory tree = StandardTree.build(leaves);
        if (vm.envOr("WRITE_LEAF_FIXTURE", false)) vm.writeFile(PATH, _json(vaultAt, accounts, amounts, tree, leaves));

        string memory json = vm.readFile(PATH);
        assertEq(vm.parseJsonString(json, ".chainId"), vm.toString(BASE_CHAIN_ID));
        assertEq(vm.parseJsonAddress(json, ".vault"), vaultAt);
        assertEq(vm.parseJsonBytes32(json, ".root"), StandardTree.root(tree));
        for (uint256 i = 0; i < COUNT; ++i) {
            string memory entry = string.concat(".entries[", vm.toString(i), "]");
            assertEq(vm.parseJsonAddress(json, string.concat(entry, ".account")), accounts[i]);
            assertEq(vm.parseUint(vm.parseJsonString(json, string.concat(entry, ".cumulativeAmount"))), amounts[i]);
            assertEq(vm.parseJsonBytes32(json, string.concat(entry, ".leaf")), leaves[i]);
            assertEq(vm.parseJsonBytes32Array(json, string.concat(entry, ".proof")), StandardTree.proof(tree, leaves[i]));
        }

        _claimEveryFixtureProof(factory, vaultAt, json, accounts, amounts);
    }

    function _claimEveryFixtureProof(
        ThuliVaultFactory factory,
        address vaultAt,
        string memory json,
        address[] memory accounts,
        uint256[] memory amounts
    ) internal {
        TestToken usd = new TestToken();
        ThuliVault vault =
            ThuliVault(factory.createVault(address(usd), owner, agent, CAP, uint64(block.timestamp) + 7 days, 1 hours));
        assertEq(address(vault), vaultAt);
        uint256 total = 0;
        for (uint256 i = 0; i < COUNT; ++i) {
            total += amounts[i] < CAP ? amounts[i] : CAP;
        }
        usd.mint(owner, total);
        vm.startPrank(owner);
        usd.approve(address(vault), total);
        vault.deposit(total);
        vm.stopPrank();
        vm.prank(agent);
        vault.postRoot(vm.parseJsonBytes32(json, ".root"), total);
        skip(1 hours);

        for (uint256 i = 0; i < COUNT; ++i) {
            bytes32[] memory proof =
                vm.parseJsonBytes32Array(json, string.concat(".entries[", vm.toString(i), "].proof"));
            if (amounts[i] == 0) {
                vm.expectRevert(abi.encodeWithSelector(ThuliVault.NothingToClaim.selector, accounts[i]));
            }
            vault.claim(accounts[i], amounts[i], proof);
            assertEq(usd.balanceOf(accounts[i]), amounts[i] < CAP ? amounts[i] : CAP);
        }
        assertEq(vault.totalPaid(), total);
    }

    /// @dev The factory keeps no state, so its code can sit at a fixed address and the vault it creates first always
    /// lands at the same address, which the fixture records.
    function _factoryAtFixedAddress() internal returns (ThuliVaultFactory) {
        address at = address(uint160(uint256(keccak256("thuli.leaf-fixture.factory"))));
        vm.etch(at, address(new ThuliVaultFactory()).code);
        return ThuliVaultFactory(at);
    }

    /// @dev Zero, one base unit, typical USDC amounts, one above the cap and the largest uint256, over an odd count so
    /// proofs come in two lengths.
    function _list() internal pure returns (address[] memory accounts, uint256[] memory amounts) {
        accounts = new address[](COUNT);
        amounts = new uint256[](COUNT);
        uint256[COUNT] memory pinned = [uint256(0), 1, 42, 999_999, 1_000_000, 323_456_789, type(uint256).max];
        for (uint256 i = 0; i < COUNT; ++i) {
            accounts[i] = address(uint160(uint256(keccak256(abi.encode("thuli.leaf-fixture.account", i)))));
            amounts[i] = pinned[i];
        }
    }

    function _json(
        address vaultAt,
        address[] memory accounts,
        uint256[] memory amounts,
        bytes32[] memory tree,
        bytes32[] memory leaves
    ) internal pure returns (string memory out) {
        out = string.concat(
            "{\n",
            "  \"chainId\": \"",
            vm.toString(BASE_CHAIN_ID),
            "\",\n  \"vault\": \"",
            vm.toString(vaultAt),
            "\",\n  \"root\": \"",
            vm.toString(StandardTree.root(tree)),
            "\",\n  \"entries\": [\n"
        );
        for (uint256 i = 0; i < COUNT; ++i) {
            out = string.concat(
                out,
                "    {\n      \"account\": \"",
                vm.toString(accounts[i]),
                "\",\n      \"cumulativeAmount\": \"",
                vm.toString(amounts[i]),
                "\",\n      \"leaf\": \"",
                vm.toString(leaves[i]),
                "\",\n      \"proof\": ",
                _array(StandardTree.proof(tree, leaves[i])),
                i + 1 < COUNT ? "\n    },\n" : "\n    }\n"
            );
        }
        out = string.concat(out, "  ]\n}\n");
    }

    function _array(bytes32[] memory values) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < values.length; ++i) {
            out = string.concat(out, i == 0 ? "\"" : ", \"", vm.toString(values[i]), "\"");
        }
        out = string.concat(out, "]");
    }
}
