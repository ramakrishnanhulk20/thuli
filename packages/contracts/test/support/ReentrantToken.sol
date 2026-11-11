// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ThuliVault} from "../../src/ThuliVault.sol";

/// @notice On the first transfer into or out of the armed vault, tries to claim from inside the transfer and records
/// why it failed. That covers deposit pulling the token in, and claim, withdrawal and rescue paying it out.
contract ReentrantToken is ERC20 {
    ThuliVault public target;
    bytes32[] private _proof;
    uint256 private _amount;
    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor() ERC20("Reentrant USD", "RUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(ThuliVault vault, uint256 cumulativeAmount, bytes32[] calldata leafProof) external {
        target = vault;
        _amount = cumulativeAmount;
        _proof = leafProof;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        bool touchesVault = from == address(target) || to == address(target);
        if (address(target) != address(0) && touchesVault && !reentered) {
            reentered = true;
            try target.claim(to, _amount, _proof) {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                reentryError = reason;
            }
        }
    }
}
