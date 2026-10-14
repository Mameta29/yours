// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Version 1 purchase protocol. Field order is the signing ABI.
interface IPurchaseGateV1 {
    struct Policy {
        address account;
        bytes32 policyId;
        uint64 version;
        uint64 validAfter;
        uint64 validUntil;
        uint64 periodStart;
        uint64 periodSeconds;
        uint256 autoPerOrderJpyc;
        uint256 autoPerPeriodJpyc;
        bytes32 merchantSetHash;
        bytes32 assetLimitsHash;
        bytes32 riskRulesHash;
        bytes32 identityBindingId;
        bytes32 relayerSetHash;
        uint32 autoMaxPremiumBps;
        uint32 humanOverrideMask;
        address merchantSigner;
        address riskSigner;
        address humanSigner;
        address priceSigner;
    }
    struct Merchant { bytes32 shopIdHash; address payTo; }
    struct AssetLimit { address token; uint256 autoPerOrder; uint256 autoPerPeriod; }
    struct GrantBinding {
        bytes32 policyId;
        uint64 policyVersion;
        address agent;
        address token;
        bytes32 grantChainHash;
        uint64 validUntil;
    }
    struct PurchaseOrder {
        bytes32 orderId;
        bytes32 revisionId;
        bytes32 policyId;
        uint64 policyVersion;
        uint64 periodIndex;
        address account;
        address agent;
        bytes32 shopIdHash;
        address payTo;
        address settlementToken;
        uint256 settlementAmount;
        bytes32 basketCommitment;
        bytes32 fundingHash;
        bytes32 requirementsHash;
        uint64 validUntil;
    }
    struct Funding {
        address token;
        uint256 maxInput;
        uint256 outputJpyc;
        address adapter;
        bytes32 routeHash;
        uint64 quoteDeadline;
    }
    struct ExecutionIntent {
        bytes32 orderHash;
        bytes32 paymentLeafHash;
        bytes32 fundingLeafHash;
        uint64 validUntil;
    }
    struct RiskStamp {
        bytes32 intentHash;
        bytes32 riskDigest;
        bytes32 rulesHash;
        uint32 reasonMask;
        uint64 checkedAt;
        uint64 validUntil;
    }
    struct PriceStamp {
        bytes32 orderHash;
        address token;
        uint256 fairInputAtomic;
        bytes32 sourceDigest;
        uint64 observedAt;
        uint64 validUntil;
    }
    struct HumanApproval {
        bytes32 approvalId;
        bytes32 intentHash;
        bytes32 riskDigest;
        bytes32 identityBindingId;
        uint32 overrideMask;
        uint64 authenticatedAt;
        uint64 validUntil;
    }
    struct Signatures {
        bytes merchant;
        bytes agent;
        bytes risk;
        bytes price;
        bytes human;
    }
    struct PurchaseResult {
        bytes32 orderHash;
        uint256 actualInput;
        uint32 reasons;
        uint256 periodJpycSpentAfter;
        uint256 periodInputSpentAfter;
    }

    error InvalidSignature(bytes32 role);
    error InvalidContext();
    error UnsupportedConfiguration();
    error PolicyInactive();
    error PolicyVersionMismatch();
    error PeriodMismatch();
    error DeadlineExpired();
    error OrderAlreadyPaid();
    error OrderCancelled();
    error RevisionInvalidated();
    error ApprovalAlreadyUsed();
    error EvidenceUnavailable();
    error HumanApprovalRequired(uint32 reasons);
    error ApprovalDoesNotCover(uint32 reasons);
    error PaymentMismatch();
    error FundingMismatch();

    event PurchasePaid(
        address indexed account, bytes32 indexed orderId, bytes32 indexed orderHash,
        bytes32 policyId, uint64 policyVersion, uint64 periodIndex,
        address payTo, uint256 settlementAmount, address inputToken,
        uint256 actualInput, bytes32 approvalId, uint32 reasonMask, bytes32 riskDigest
    );
    event PolicyRegistered(address indexed account, bytes32 indexed policyId, uint64 version);
    event PolicyRevoked(address indexed account, bytes32 indexed policyId);
    event OrderCancellation(address indexed account, bytes32 indexed orderId);
    event RevisionInvalidation(address indexed account, bytes32 indexed orderId, bytes32 revisionId);

    function registerPolicy(
        Policy calldata p, Merchant[] calldata shops, AssetLimit[] calldata assets,
        GrantBinding[] calldata grants, address[] calldata relayers,
        uint64 nonce, uint64 validUntil, bytes calldata ownerSignature
    ) external;
    function updatePolicy(
        Policy calldata next, Merchant[] calldata shops, AssetLimit[] calldata assets,
        GrantBinding[] calldata grants, address[] calldata relayers,
        uint64 nonce, uint64 validUntil, bytes calldata ownerSignature
    ) external;
    function revokePolicy(address account, bytes32 policyId, uint64 nonce,
                          uint64 validUntil, bytes calldata ownerSignature) external;
    function cancelOrder(address account, bytes32 orderId, uint64 nonce,
                         uint64 validUntil, bytes calldata ownerSignature) external;
    function invalidateRevision(address account, bytes32 policyId, bytes32 orderId,
        bytes32 revisionId, uint64 nonce, uint64 validUntil, bytes calldata merchantSignature) external;
    function executePurchase(
        PurchaseOrder calldata o, Funding calldata f, ExecutionIntent calldata i,
        bytes calldata paymentContext, bytes calldata fundingContext,
        RiskStamp calldata r, PriceStamp calldata p, HumanApproval calldata h,
        Signatures calldata signatures, bytes calldata route
    ) external returns (PurchaseResult memory);
    function paidOrderHash(address account, bytes32 orderId) external view returns (bytes32);
    function isOrderCancelled(address account, bytes32 orderId) external view returns (bool);
    function isRevisionInvalidated(address account, bytes32 orderId, bytes32 revisionId) external view returns (bool);
    function isApprovalUsed(address account, bytes32 approvalId) external view returns (bool);
    function spentJpyc(address account, bytes32 policyId, uint64 periodIndex) external view returns (uint256);
    function spentInput(address account, bytes32 policyId, uint64 periodIndex, address token) external view returns (uint256);
}
