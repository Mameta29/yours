// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GateFixture} from "./GateFixture.sol";
import {IPurchaseGateV1 as I} from "../src/IPurchaseGateV1.sol";
import {GateHash} from "../src/GateHash.sol";
import {DelegationCodec as D} from "../src/DelegationCodec.sol";

contract PurchaseGateTest is GateFixture {
    function testNormalPaymentAndOrderReplay() public {
        OrderCase memory c = _case(1500e18, false); _execute(c);
        require(jpyc.balanceOf(merchant) == 1500e18 && _spent() == 1500e18);
        vm.expectRevert(I.OrderAlreadyPaid.selector); _execute(c);
        c.o.revisionId = bytes32(++sequence); _resign(c);
        vm.expectRevert(I.OrderAlreadyPaid.selector); _execute(c);
    }
    function testPeriodExceptionCountsAndDoesNotResetBudget() public {
        p.autoPerOrderJpyc = 10000e18; p.version++; _register(true);
        _execute(_case(9000e18, false));
        OrderCase memory c = _case(2000e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(c);
        _approve(c, 2); _execute(c);
        require(_spent() == 11000e18);
        OrderCase memory next = _case(1e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(next);
    }
    function testVersionUpdateAndRevocationPreserveSpent() public {
        _execute(_case(1000e18, false));
        OrderCase memory old = _case(1000e18, false);
        p.version++; _register(true); require(_spent() == 1000e18);
        vm.expectRevert(I.PolicyVersionMismatch.selector); _execute(old);
        uint64 n = gate.ownerNonce(owner); uint64 until = uint64(block.timestamp+100);
        bytes memory sig = _sign(OWNER_KEY, keccak256(abi.encode(GateHash.REVOKE, owner, p.policyId, n, until)));
        gate.revokePolicy(owner, p.policyId, n, until, sig);
        OrderCase memory next = _case(1000e18, false);
        vm.expectRevert(I.PolicyInactive.selector); _execute(next);
        p.version++; _register(true); require(_spent() == 1000e18);
    }
    function testPeriodAnchorCannotResetSpent() public {
        p.version++; p.periodStart--;
        uint64 nonce = gate.ownerNonce(owner);
        vm.expectRevert(I.UnsupportedConfiguration.selector);
        gate.updatePolicy(p, shops, assets, grants, senders, nonce, uint64(block.timestamp+100), hex"01");
    }
    function testHumanCannotAuthorizeAnotherOrderOrAnotherRisk() public {
        OrderCase memory c = _case(2000e18, false); _approve(c, 1);
        c.o.revisionId = bytes32(++sequence); _resign(c);
        vm.expectRevert(I.EvidenceUnavailable.selector); _execute(c);
        _approve(c, 1); c.r.riskDigest = keccak256("new risk"); c.sig.risk = _sign(R_KEY, GateHash.hash(c.r));
        vm.expectRevert(I.EvidenceUnavailable.selector); _execute(c);
    }
    function testNewMerchantIsOneOrderOnly() public {
        merchant = address(201); OrderCase memory c = _case(1000e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(4))); _execute(c);
        _approve(c, 4); _execute(c);
        OrderCase memory next = _case(1000e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(4))); _execute(next);
    }
    function testFutureAndExpiredEvidenceCannotBeOverridden() public {
        OrderCase memory c = _case(2000e18, false); _approve(c, 255);
        c.h.authenticatedAt = uint64(block.timestamp+31); c.sig.human = _sign(H_KEY, GateHash.hash(c.h));
        vm.expectRevert(I.EvidenceUnavailable.selector); _execute(c);
        _approve(c, 255); c.r.validUntil = uint64(block.timestamp); c.sig.risk = _sign(R_KEY, GateHash.hash(c.r));
        vm.expectRevert(I.DeadlineExpired.selector); _execute(c);
    }
    function testRiskSignerCannotSuppressOnchainBudgetReasons() public {
        OrderCase memory c = _case(2000e18, false); c.r.reasonMask = 1; c.sig.risk = _sign(R_KEY, GateHash.hash(c.r));
        vm.expectRevert(I.EvidenceUnavailable.selector); _execute(c);
    }
    function testUnlistedRelayerAndMutableArgsRejected() public {
        OrderCase memory c = _case(1000e18, false);
        vm.prank(address(333)); vm.expectRevert(I.UnsupportedConfiguration.selector); _execute(c);
        D.Delegation[] memory chain = abi.decode(c.payment, (D.Delegation[])); chain[0].caveats[0].args = hex"01"; c.payment = abi.encode(chain);
        vm.expectRevert(I.InvalidContext.selector); _execute(c);
    }
    function testMissingParentGateEvenWithOwnerRegisteredHashRejected() public {
        OrderCase memory c = _case(1000e18, false); D.Delegation[] memory chain = abi.decode(c.payment, (D.Delegation[]));
        chain[1].caveats[1].terms = abi.encodePacked(agent); chain[0].authority = D.hash(chain[1]);
        c.payment = abi.encode(chain); c.i.paymentLeafHash = D.hash(chain[0]); _resign(c);
        vm.expectRevert(I.InvalidContext.selector); _execute(c);
    }
    function testSwapCountsNetInputReturnsChangeAndClearsAllowance() public {
        OrderCase memory c = _case(1000e18, true); I.PurchaseResult memory r = _execute(c);
        require(r.actualInput == 9_600_000 && r.periodInputSpentAfter == 9_600_000);
        require(usdc.balanceOf(owner) == 90_400_000 && jpyc.balanceOf(merchant) == 1000e18);
        require(usdc.balanceOf(address(gate)) == 0 && usdc.balanceOf(address(gate.fundingAdapter())) == 0);
        require(usdc.allowance(address(gate), address(gate.fundingAdapter())) == 0 && usdc.allowance(address(gate.fundingAdapter()), address(router)) == 0);
    }
    function testPaymentFailureRollsBackSwapSpentAndApproval() public {
        OrderCase memory c = _case(2000e18, true); _approve(c, 1); jpyc.setFailTransfer(true);
        vm.expectRevert(); _execute(c);
        require(_spent() == 0 && usdc.balanceOf(owner) == 100_000_000 && usdc.balanceOf(address(router)) == 0);
        require(!gate.isApprovalUsed(owner, c.h.approvalId) && gate.paidOrderHash(owner, c.o.orderId) == 0);
        jpyc.setFailTransfer(false); _execute(c); require(_spent() == 2000e18);
    }
    function testPremiumNeedsSpecificApprovalAndNeverRaisesMaxInput() public {
        OrderCase memory c = _case(1000e18, true); c.price.fairInputAtomic = 5_000_000; c.sig.price = _sign(P_KEY, GateHash.hash(c.price));
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(32))); _execute(c);
        _approve(c, 4); vm.expectRevert(abi.encodeWithSelector(I.ApprovalDoesNotCover.selector, uint32(32))); _execute(c);
        _approve(c, 32); router.setActualInput(10_000_001); vm.expectRevert(); _execute(c);
        router.setActualInput(9_600_000); _execute(c);
    }
    function testCancelAndInvalidatedRevisionRefuseHumanApproval() public {
        OrderCase memory c = _case(2000e18, false); _approve(c, 1);
        uint64 n = gate.ownerNonce(owner); uint64 until = uint64(block.timestamp+100);
        gate.cancelOrder(owner, c.o.orderId, n, until, _sign(OWNER_KEY, keccak256(abi.encode(GateHash.CANCEL, owner, c.o.orderId, n, until))));
        vm.expectRevert(I.OrderCancelled.selector); _execute(c);
        c = _case(2000e18, false); _approve(c, 1); n = gate.merchantNonce(owner);
        gate.invalidateRevision(owner, p.policyId, c.o.orderId, c.o.revisionId, n, until, _sign(M_KEY, keccak256(abi.encode(GateHash.INVALIDATEREVISION, owner, p.policyId, c.o.orderId, c.o.revisionId, n, until))));
        vm.expectRevert(I.RevisionInvalidated.selector); _execute(c);
    }
    function testPeriodTransitionDoesNotReusePriorOrder() public {
        OrderCase memory c = _case(1000e18, false); c.o.validUntil = uint64(block.timestamp+4000); _resign(c);
        vm.warp(block.timestamp+3600); c.r.checkedAt = uint64(block.timestamp); c.r.validUntil = uint64(block.timestamp+60); c.sig.risk = _sign(R_KEY, GateHash.hash(c.r));
        vm.expectRevert(I.PeriodMismatch.selector); _execute(c);
        c = _case(1000e18, false); _execute(c); require(gate.spentJpyc(owner, p.policyId, 1) == 1000e18 && _spent() == 0);
    }
    function testFuzzAutomaticBoundary(uint96 raw) public {
        uint256 amount = uint256(raw) % (3000e18) + 1; OrderCase memory c = _case(amount, false);
        if (amount > p.autoPerOrderJpyc) { vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(1))); _execute(c); require(_spent() == 0); }
        else { _execute(c); require(_spent() == amount); }
    }
}
