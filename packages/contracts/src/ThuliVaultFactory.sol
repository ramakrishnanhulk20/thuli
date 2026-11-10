// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ThuliVault} from "./ThuliVault.sol";

/// @title ThuliVaultFactory
/// @author Thuli
/// @notice Deploys one ThuliVault per campaign. It has no owner and no settings, and it cannot change a vault after
/// creating it.
/// @dev A fresh vault per campaign keeps every deposit in its own account (C29), and a code change means a new
/// factory for new campaigns rather than an admin swapping code under a live one. Anyone can call createVault, and
/// may name any address as owner, so an index of vaults must not treat a VaultCreated event as proof that the named
/// owner asked for it.
contract ThuliVaultFactory {
    /// @notice A vault was deployed for one campaign.
    /// @param vault The new vault.
    /// @param owner The project named as its owner.
    /// @param agent The root-posting key.
    /// @param token The reward token.
    /// @param perWalletCap The most one wallet can ever receive.
    /// @param endTime When claims stop.
    /// @param rootDelay Seconds every root waits before it pays.
    event VaultCreated(
        address indexed vault,
        address indexed owner,
        address indexed agent,
        address token,
        uint256 perWalletCap,
        uint64 endTime,
        uint32 rootDelay
    );

    /// @notice Deploys a vault for one campaign.
    /// @dev Every bound is checked by the ThuliVault constructor, whose custom errors bubble up unchanged.
    /// Emits VaultCreated.
    /// @param token The reward token.
    /// @param owner The project running the campaign.
    /// @param agent Thuli's root-posting key, different from the owner.
    /// @param perWalletCap The most one wallet can ever receive.
    /// @param endTime When claims stop: in the future and at most 365 days out.
    /// @param rootDelay Seconds every root waits before it pays, from 1 hour to 30 days.
    /// @return vault The new vault's address.
    function createVault(
        address token,
        address owner,
        address agent,
        uint256 perWalletCap,
        uint64 endTime,
        uint32 rootDelay
    ) external returns (address vault) {
        vault = address(new ThuliVault(token, owner, agent, perWalletCap, endTime, rootDelay));
        emit VaultCreated(vault, owner, agent, token, perWalletCap, endTime, rootDelay);
    }
}
