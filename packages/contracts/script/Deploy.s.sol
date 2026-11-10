// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script} from "forge-std/Script.sol";
import {ThuliVaultFactory} from "../src/ThuliVaultFactory.sol";

/// @title Deploy
/// @author Thuli
/// @notice Deploys ThuliVaultFactory to Base Sepolia from the worker key. Run it through `npm run vault:deploy`, which
/// also verifies the factory and records it in deployments/base-sepolia.json.
contract Deploy is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;

    error WrongChain(uint256 chainId);

    /// @notice Deploys one factory.
    /// @dev Reads WORKER_PRIVATE_KEY from the environment so the key never appears on a command line. Reverts with
    /// WrongChain anywhere but Base Sepolia, including a local fork that reports another chain id.
    /// @return factory The new factory.
    function run() external returns (ThuliVaultFactory factory) {
        if (block.chainid != BASE_SEPOLIA) revert WrongChain(block.chainid);
        uint256 key = vm.envUint("WORKER_PRIVATE_KEY");
        vm.startBroadcast(key);
        factory = new ThuliVaultFactory();
        vm.stopBroadcast();
    }
}
