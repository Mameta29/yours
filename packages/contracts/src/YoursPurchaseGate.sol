// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PurchaseGateV1} from "./PurchaseGateV1.sol";
import {AgentPermissionRegistry} from "./AgentPermissionRegistry.sol";

/// @notice Enforces both the owner's shared budget and each AI connection's
/// budget in the same EVM transaction as the actual token transfer.
contract YoursPurchaseGate is PurchaseGateV1 {
    AgentPermissionRegistry public immutable agentPermissions;
    constructor(address m, address jpyc, address usdc, address implementation, address router, address factory, address[7] memory e)
        PurchaseGateV1(m, jpyc, usdc, implementation, router, factory, e) {
        agentPermissions = new AgentPermissionRegistry();
    }
    function _consumeAgentBudget(PurchaseOrder calldata o, HumanApproval calldata, bool) internal override returns (uint32) {
        return agentPermissions.consume(o);
    }
}
