// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice A copy, for tests only, of how @openzeppelin/merkle-tree lays out a StandardMerkleTree: leaves sorted
/// ascending and stored at the end of one array, the parent of node i at (i - 1) / 2, each pair hashed in sorted
/// order. packages/core/test/leaf.test.ts checks this copy against the real library through
/// test/fixtures/leaf-tree.json, so a tree built here is the tree the worker would build.
library StandardTree {
    error EmptyTree();
    error NotInTree(bytes32 node);

    function leafHash(uint256 chainId, address vault, address account, uint256 cumulativeAmount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(chainId, vault, account, cumulativeAmount))));
    }

    function build(bytes32[] memory leaves) internal pure returns (bytes32[] memory tree) {
        uint256 count = leaves.length;
        if (count == 0) revert EmptyTree();
        bytes32[] memory sorted = _sorted(leaves);
        tree = new bytes32[](2 * count - 1);
        for (uint256 i = 0; i < count; ++i) {
            tree[tree.length - 1 - i] = sorted[i];
        }
        for (uint256 k = count - 1; k > 0; --k) {
            uint256 parent = k - 1;
            tree[parent] = hashPair(tree[2 * parent + 1], tree[2 * parent + 2]);
        }
    }

    function root(bytes32[] memory tree) internal pure returns (bytes32) {
        return tree[0];
    }

    function proof(bytes32[] memory tree, bytes32 leaf) internal pure returns (bytes32[] memory) {
        uint256 leafCount = (tree.length + 1) / 2;
        for (uint256 index = leafCount - 1; index < tree.length; ++index) {
            if (tree[index] == leaf) return proofAt(tree, index);
        }
        revert NotInTree(leaf);
    }

    /// @dev Works for any node, internal nodes included, which the second-preimage tests need.
    function proofAt(bytes32[] memory tree, uint256 index) internal pure returns (bytes32[] memory path) {
        uint256 depth = 0;
        for (uint256 i = index; i > 0; i = (i - 1) / 2) {
            ++depth;
        }
        path = new bytes32[](depth);
        uint256 step = 0;
        for (uint256 i = index; i > 0; i = (i - 1) / 2) {
            path[step] = tree[i % 2 == 1 ? i + 1 : i - 1];
            ++step;
        }
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _sorted(bytes32[] memory values) private pure returns (bytes32[] memory out) {
        out = new bytes32[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            bytes32 value = values[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] > value) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = value;
        }
    }
}
