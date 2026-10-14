// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatePolicy} from "./GatePolicy.sol";
import {GateHash} from "./GateHash.sol";
import {DelegationCodec as D, IDelegationManagerV1} from "./DelegationCodec.sol";
import {UniswapV3FundingAdapterV1} from "./UniswapV3FundingAdapterV1.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Immutable purchase-only redeemer. The standard root is unlimited;
/// budgets and order-specific human exceptions are enforced here.
contract PurchaseGateV1 is GatePolicy {
    using SafeERC20 for IERC20;
    IDelegationManagerV1 public immutable manager;
    UniswapV3FundingAdapterV1 public immutable fundingAdapter;

    constructor(address m, address jpyc, address usdc, address implementation, address router, address factory, address[7] memory e)
        GatePolicy(jpyc, usdc, implementation, e) {
        if (m.code.length == 0) revert UnsupportedConfiguration();
        manager = IDelegationManagerV1(m);
        fundingAdapter = new UniswapV3FundingAdapterV1(address(this), usdc, jpyc, router, factory);
    }

    function executePurchase(PurchaseOrder calldata o, Funding calldata f, ExecutionIntent calldata i, bytes calldata paymentContext, bytes calldata fundingContext, RiskStamp calldata r, PriceStamp calldata p, HumanApproval calldata h, Signatures calldata sig, bytes calldata route) external override nonReentrant returns (PurchaseResult memory result) {
        Policy storage policy_ = policies[o.account];
        _validateOrder(policy_, o, f, i, sig);
        if (paidOrderHash[o.account][o.orderId] != bytes32(0)) revert OrderAlreadyPaid();
        if (isOrderCancelled[o.account][o.orderId]) revert OrderCancelled();
        if (isRevisionInvalidated[o.account][o.orderId][o.revisionId]) revert RevisionInvalidated();
        _context(o, paymentContext, settlementToken, o.payTo, o.settlementAmount, i.paymentLeafHash);
        bytes32 intentHash = _hashTypedDataV4(GateHash.hash(i));
        _risk(policy_, r, intentHash, sig.risk);
        bool hasHuman = sig.human.length > 0;
        _human(policy_, h, r, intentHash, sig.human, hasHuman);
        uint256 jpycAfter = spentJpyc[o.account][o.policyId][o.periodIndex] + o.settlementAmount;
        uint32 reasons = r.reasonMask | _consumeAgentBudget(o, h, hasHuman);
        if (o.settlementAmount > policy_.autoPerOrderJpyc) reasons |= 1;
        if (jpycAfter > policy_.autoPerPeriodJpyc) reasons |= 2;
        if (!merchants[o.account][o.policyVersion][keccak256(abi.encode(Merchant(o.shopIdHash, o.payTo)))]) reasons |= 4;
        _cover(reasons, h.overrideMask, hasHuman);
        // Effects precede external calls; all roll back on any funding/payment failure.
        paidOrderHash[o.account][o.orderId] = i.orderHash;
        if (hasHuman) isApprovalUsed[o.account][h.approvalId] = true;
        spentJpyc[o.account][o.policyId][o.periodIndex] = jpycAfter;
        uint256 actualInput;
        uint256 inputAfter;
        uint256 gateJpyc = IERC20(settlementToken).balanceOf(address(this));
        if (f.token == address(0)) {
            if (GateHash.hash(f) != GateHash.hash(Funding(address(0), 0, 0, address(0), 0, 0)) || fundingContext.length != 0 || i.fundingLeafHash != 0 || route.length != 0 || sig.price.length != 0 || GateHash.hash(p) != GateHash.hash(PriceStamp(0, address(0), 0, 0, 0, 0))) revert FundingMismatch();
        } else {
            _price(policy_, o, f, p, sig.price);
            _context(o, fundingContext, inputToken, address(this), f.maxInput, i.fundingLeafHash);
            actualInput = _fund(o, f, fundingContext, route);
            inputAfter = spentInput[o.account][o.policyId][o.periodIndex][inputToken] + actualInput;
            AssetLimit storage lim = limits[o.account][o.policyVersion][inputToken];
            if (actualInput > lim.autoPerOrder) reasons |= 8;
            if (inputAfter > lim.autoPerPeriod) reasons |= 16;
            if (actualInput > Math.mulDiv(p.fairInputAtomic, 10000 + policy_.autoMaxPremiumBps, 10000)) reasons |= 32;
            _cover(reasons, h.overrideMask, hasHuman);
            spentInput[o.account][o.policyId][o.periodIndex][inputToken] = inputAfter;
        }
        uint256 merchantBefore = IERC20(settlementToken).balanceOf(o.payTo);
        uint256 ownerBefore = IERC20(settlementToken).balanceOf(o.account);
        _transfer(paymentContext, settlementToken, o.payTo, o.settlementAmount);
        if (IERC20(settlementToken).balanceOf(o.payTo) != merchantBefore + o.settlementAmount || IERC20(settlementToken).balanceOf(o.account) + o.settlementAmount != ownerBefore || IERC20(settlementToken).balanceOf(address(this)) != gateJpyc) revert PaymentMismatch();
        emit PurchasePaid(o.account, o.orderId, i.orderHash, o.policyId, o.policyVersion, o.periodIndex, o.payTo, o.settlementAmount, f.token, actualInput, h.approvalId, reasons, r.riskDigest);
        return PurchaseResult(i.orderHash, actualInput, reasons, jpycAfter, inputAfter);
    }

    /// @dev Extension point runs inside the purchase's atomic transaction. A later
    /// transfer failure reverts the agent ledger as well as the shared ledger.
    function _consumeAgentBudget(PurchaseOrder calldata, HumanApproval calldata, bool) internal virtual returns (uint32) { return 0; }

    function _validateOrder(Policy storage p, PurchaseOrder calldata o, Funding calldata f, ExecutionIntent calldata i, Signatures calldata s) private view {
        if (!active[o.account] || p.policyId != o.policyId || block.timestamp < p.validAfter || block.timestamp >= p.validUntil) revert PolicyInactive();
        if (p.version != o.policyVersion) revert PolicyVersionMismatch();
        if ((block.timestamp - p.periodStart) / p.periodSeconds != o.periodIndex) revert PeriodMismatch();
        if (!relayers[o.account][o.policyVersion][msg.sender]) revert UnsupportedConfiguration();
        _account(o.account);
        _deadline(o.validUntil); _deadline(i.validUntil);
        if (o.validUntil > p.validUntil || i.validUntil > o.validUntil || o.orderId == 0 || o.revisionId == 0 || o.basketCommitment == 0 || o.shopIdHash == 0 || o.settlementAmount == 0 || o.settlementToken != settlementToken || o.payTo == address(0) || o.payTo == o.account || o.payTo == address(this) || o.payTo == address(fundingAdapter)) revert PaymentMismatch();
        if (GateHash.hash(f) != o.fundingHash || _hashTypedDataV4(GateHash.hash(o)) != i.orderHash) revert InvalidContext();
        if (o.requirementsHash != keccak256(abi.encode(block.chainid, settlementToken, o.payTo, o.settlementAmount, keccak256("exact"), keccak256("erc7710"), address(this), uint32(1)))) revert PaymentMismatch();
        _signature(p.merchantSigner, GateHash.hash(o), s.merchant, "merchant");
        _signature(o.agent, GateHash.hash(i), s.agent, "agent");
    }
    function _risk(Policy storage p, RiskStamp calldata r, bytes32 intentHash, bytes calldata signature) private view {
        _deadline(r.validUntil);
        if (r.intentHash != intentHash || r.rulesHash != p.riskRulesHash || r.riskDigest == 0 || r.reasonMask & ~uint32(192) != 0 || r.checkedAt > block.timestamp + 30 || r.validUntil > uint256(r.checkedAt) + 60 || block.timestamp > uint256(r.checkedAt) + 60) revert EvidenceUnavailable();
        _signature(p.riskSigner, GateHash.hash(r), signature, "risk");
    }
    function _human(Policy storage p, HumanApproval calldata h, RiskStamp calldata r, bytes32 intentHash, bytes calldata signature, bool present) private view {
        if (!present) {
            if (GateHash.hash(h) != GateHash.hash(HumanApproval(0, 0, 0, 0, 0, 0, 0))) revert InvalidContext();
            return;
        }
        _deadline(h.validUntil);
        if (h.approvalId == 0 || h.intentHash != intentHash || h.riskDigest != r.riskDigest || h.identityBindingId != p.identityBindingId || h.overrideMask & ~p.humanOverrideMask != 0 || h.authenticatedAt > block.timestamp + 30 || block.timestamp > uint256(h.authenticatedAt) + 120 || h.validUntil > uint256(h.authenticatedAt) + 120) revert EvidenceUnavailable();
        if (isApprovalUsed[p.account][h.approvalId]) revert ApprovalAlreadyUsed();
        _signature(p.humanSigner, GateHash.hash(h), signature, "human");
    }
    function _cover(uint32 reasons, uint32 mask, bool present) private pure {
        if (reasons != 0 && !present) revert HumanApprovalRequired(reasons);
        if (present && reasons & ~mask != 0) revert ApprovalDoesNotCover(reasons);
    }
    function _price(Policy storage policy_, PurchaseOrder calldata o, Funding calldata f, PriceStamp calldata p, bytes calldata signature) private view {
        _deadline(f.quoteDeadline); _deadline(p.validUntil);
        if (f.token != inputToken || f.adapter != address(fundingAdapter) || limits[o.account][o.policyVersion][inputToken].token != inputToken || f.maxInput == 0 || f.outputJpyc == 0 || f.outputJpyc > o.settlementAmount || f.quoteDeadline > o.validUntil || p.orderHash != _hashTypedDataV4(GateHash.hash(o)) || p.token != inputToken || p.fairInputAtomic == 0 || p.sourceDigest == 0 || p.observedAt > block.timestamp + 30 || block.timestamp > uint256(p.observedAt) + 96 hours || p.validUntil > uint256(p.observedAt) + 96 hours) revert EvidenceUnavailable();
        _signature(policy_.priceSigner, GateHash.hash(p), signature, "price");
    }
    function _fund(PurchaseOrder calldata o, Funding calldata f, bytes calldata context, bytes calldata route) private returns (uint256 actual) {
        if (route.length != 43 || keccak256(route) != f.routeHash || IERC20(settlementToken).balanceOf(o.account) < o.settlementAmount - f.outputJpyc) revert FundingMismatch();
        IERC20 token = IERC20(inputToken);
        uint256 ownerBefore = token.balanceOf(o.account);
        uint256 gateBefore = token.balanceOf(address(this));
        uint256 adapterBefore = token.balanceOf(address(fundingAdapter));
        _transfer(context, inputToken, address(this), f.maxInput);
        if (token.balanceOf(address(this)) != gateBefore + f.maxInput || token.balanceOf(o.account) + f.maxInput != ownerBefore) revert FundingMismatch();
        token.forceApprove(address(fundingAdapter), f.maxInput);
        actual = fundingAdapter.fund(o.account, f.maxInput, f.outputJpyc, f.quoteDeadline, route);
        token.forceApprove(address(fundingAdapter), 0);
        if (actual > f.maxInput || token.balanceOf(o.account) + actual != ownerBefore || token.balanceOf(address(this)) != gateBefore || token.balanceOf(address(fundingAdapter)) != adapterBefore || token.allowance(address(this), address(fundingAdapter)) != 0) revert FundingMismatch();
    }
    function _transfer(bytes calldata context, address token, address to, uint256 amount) private {
        bytes[] memory contexts = new bytes[](1); contexts[0] = context;
        bytes32[] memory modes = new bytes32[](1); // single/default; never batch/delegatecall
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodePacked(token, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount)));
        manager.redeemDelegations(contexts, modes, calls);
    }
    function _context(PurchaseOrder calldata o, bytes calldata context, address token, address payee, uint256 amount, bytes32 leafHash) private view {
        GrantBinding storage g = bindings[o.account][o.policyVersion][o.agent][token];
        if (g.grantChainHash == 0 || g.validUntil < o.validUntil) revert InvalidContext();
        validator.validateContext(context, o.account, o.agent, token, payee, amount, leafHash, g.grantChainHash);
    }
}
