// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Generated from IPurchaseGateV1.sol.
import {IPurchaseGateV1 as I} from "./IPurchaseGateV1.sol";

library GateHash {
    bytes32 internal constant POLICY = keccak256("Policy(address account,bytes32 policyId,uint64 version,uint64 validAfter,uint64 validUntil,uint64 periodStart,uint64 periodSeconds,uint256 autoPerOrderJpyc,uint256 autoPerPeriodJpyc,bytes32 merchantSetHash,bytes32 assetLimitsHash,bytes32 riskRulesHash,bytes32 identityBindingId,bytes32 relayerSetHash,uint32 autoMaxPremiumBps,uint32 humanOverrideMask,address merchantSigner,address riskSigner,address humanSigner,address priceSigner)");
    function hash(I.Policy memory v) internal pure returns (bytes32) { return keccak256(abi.encode(POLICY, v)); }
    bytes32 internal constant MERCHANT = keccak256("Merchant(bytes32 shopIdHash,address payTo)");
    function hash(I.Merchant memory v) internal pure returns (bytes32) { return keccak256(abi.encode(MERCHANT, v)); }
    bytes32 internal constant ASSETLIMIT = keccak256("AssetLimit(address token,uint256 autoPerOrder,uint256 autoPerPeriod)");
    function hash(I.AssetLimit memory v) internal pure returns (bytes32) { return keccak256(abi.encode(ASSETLIMIT, v)); }
    bytes32 internal constant GRANTBINDING = keccak256("GrantBinding(bytes32 policyId,uint64 policyVersion,address agent,address token,bytes32 grantChainHash,uint64 validUntil)");
    function hash(I.GrantBinding memory v) internal pure returns (bytes32) { return keccak256(abi.encode(GRANTBINDING, v)); }
    bytes32 internal constant PURCHASEORDER = keccak256("PurchaseOrder(bytes32 orderId,bytes32 revisionId,bytes32 policyId,uint64 policyVersion,uint64 periodIndex,address account,address agent,bytes32 shopIdHash,address payTo,address settlementToken,uint256 settlementAmount,bytes32 basketCommitment,bytes32 fundingHash,bytes32 requirementsHash,uint64 validUntil)");
    function hash(I.PurchaseOrder memory v) internal pure returns (bytes32) { return keccak256(abi.encode(PURCHASEORDER, v)); }
    bytes32 internal constant FUNDING = keccak256("Funding(address token,uint256 maxInput,uint256 outputJpyc,address adapter,bytes32 routeHash,uint64 quoteDeadline)");
    function hash(I.Funding memory v) internal pure returns (bytes32) { return keccak256(abi.encode(FUNDING, v)); }
    bytes32 internal constant EXECUTIONINTENT = keccak256("ExecutionIntent(bytes32 orderHash,bytes32 paymentLeafHash,bytes32 fundingLeafHash,uint64 validUntil)");
    function hash(I.ExecutionIntent memory v) internal pure returns (bytes32) { return keccak256(abi.encode(EXECUTIONINTENT, v)); }
    bytes32 internal constant RISKSTAMP = keccak256("RiskStamp(bytes32 intentHash,bytes32 riskDigest,bytes32 rulesHash,uint32 reasonMask,uint64 checkedAt,uint64 validUntil)");
    function hash(I.RiskStamp memory v) internal pure returns (bytes32) { return keccak256(abi.encode(RISKSTAMP, v)); }
    bytes32 internal constant PRICESTAMP = keccak256("PriceStamp(bytes32 orderHash,address token,uint256 fairInputAtomic,bytes32 sourceDigest,uint64 observedAt,uint64 validUntil)");
    function hash(I.PriceStamp memory v) internal pure returns (bytes32) { return keccak256(abi.encode(PRICESTAMP, v)); }
    bytes32 internal constant HUMANAPPROVAL = keccak256("HumanApproval(bytes32 approvalId,bytes32 intentHash,bytes32 riskDigest,bytes32 identityBindingId,uint32 overrideMask,uint64 authenticatedAt,uint64 validUntil)");
    function hash(I.HumanApproval memory v) internal pure returns (bytes32) { return keccak256(abi.encode(HUMANAPPROVAL, v)); }
    bytes32 internal constant SIGNATURES = keccak256("Signatures(bytes merchant,bytes agent,bytes risk,bytes price,bytes human)");
    bytes32 internal constant PURCHASERESULT = keccak256("PurchaseResult(bytes32 orderHash,uint256 actualInput,uint32 reasons,uint256 periodJpycSpentAfter,uint256 periodInputSpentAfter)");
    function hash(I.PurchaseResult memory v) internal pure returns (bytes32) { return keccak256(abi.encode(PURCHASERESULT, v)); }
    bytes32 internal constant POLICYREGISTRATION = keccak256("PolicyRegistration(bytes32 policyHash,bytes32 grantsHash,uint64 nonce,uint64 validUntil)");
    bytes32 internal constant REVOKE = keccak256("Revoke(address account,bytes32 policyId,uint64 nonce,uint64 validUntil)");
    bytes32 internal constant CANCEL = keccak256("Cancel(address account,bytes32 orderId,uint64 nonce,uint64 validUntil)");
    bytes32 internal constant INVALIDATEREVISION = keccak256("InvalidateRevision(address account,bytes32 policyId,bytes32 orderId,bytes32 revisionId,uint64 nonce,uint64 validUntil)");
}
