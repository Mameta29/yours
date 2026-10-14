// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPurchaseGateV1 as I} from "../src/IPurchaseGateV1.sol";
import {PurchaseGateV1} from "../src/PurchaseGateV1.sol";
import {GateHash} from "../src/GateHash.sol";
import {DelegationCodec as D} from "../src/DelegationCodec.sol";
import {IV3Router02} from "../src/UniswapV3FundingAdapterV1.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface Vm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 hash) external returns (uint8 v, bytes32 r, bytes32 s);
    function etch(address target, bytes calldata code) external;
    function warp(uint256 time) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectRevert() external;
}
contract MockCode {}
/// @dev Gate unit tests only. Official Manager/account behavior has separate integration tests.
contract MockToken is ERC20 {
    bool public failTransfer;
    constructor() ERC20("UNIT TEST ONLY", "TEST") {}
    function mint(address to, uint256 value) external { _mint(to, value); }
    function setFailTransfer(bool fail) external { failTransfer = fail; }
    function managerMove(address from, address to, uint256 value) external { require(!failTransfer, "blocked"); _transfer(from, to, value); }
}
contract MockManager {
    function redeemDelegations(bytes[] calldata contexts, bytes32[] calldata modes, bytes[] calldata executions) external {
        require(contexts.length == 1 && modes.length == 1 && modes[0] == bytes32(0) && executions.length == 1, "mode");
        D.Delegation[] memory chain = abi.decode(contexts[0], (D.Delegation[]));
        bytes calldata call_ = executions[0];
        require(call_.length == 120 && uint256(bytes32(call_[20:52])) == 0 && bytes4(call_[52:56]) == ERC20.transfer.selector, "call");
        (address payee, uint256 amount) = abi.decode(call_[56:], (address, uint256));
        MockToken(address(bytes20(call_[:20]))).managerMove(chain[chain.length-1].delegator, payee, amount);
    }
}
contract MockFactory { function getPool(address, address, uint24) external view returns (address) { return address(this); } }
contract MockRouter is IV3Router02 {
    address public immutable override factory;
    uint256 public actualInput = 9_600_000;
    constructor(address f) { factory = f; }
    function setActualInput(uint256 amount) external { actualInput = amount; }
    function exactOutput(ExactOutputParams calldata p) external payable returns (uint256) {
        require(actualInput <= p.amountInMaximum, "maximum");
        MockToken input = MockToken(address(bytes20(p.path[23:43])));
        MockToken output = MockToken(address(bytes20(p.path[0:20])));
        input.transferFrom(msg.sender, address(this), actualInput);
        output.mint(p.recipient, p.amountOut);
        return actualInput;
    }
}

abstract contract GateFixture {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant OWNER_KEY = 100;
    uint256 constant AGENT_KEY = 101;
    uint256 constant M_KEY = 102;
    uint256 constant R_KEY = 103;
    uint256 constant H_KEY = 104;
    uint256 constant P_KEY = 105;
    address owner;
    address agent;
    address merchant = address(200);
    PurchaseGateV1 gate;
    MockToken jpyc;
    MockToken usdc;
    MockRouter router;
    I.Policy p;
    I.Merchant[] shops;
    I.AssetLimit[] assets;
    I.GrantBinding[] grants;
    address[] senders;
    address[7] enforcers;
    uint256 sequence;

    struct OrderCase { I.PurchaseOrder o; I.Funding f; I.ExecutionIntent i; bytes payment; bytes funding; I.RiskStamp r; I.PriceStamp price; I.HumanApproval h; I.Signatures sig; bytes route; }

    function setUp() public virtual {
        vm.warp(1_790_380_800);
        owner = vm.addr(OWNER_KEY); agent = vm.addr(AGENT_KEY);
        address implementation = address(new MockCode());
        vm.etch(owner, abi.encodePacked(hex"ef0100", implementation));
        jpyc = new MockToken(); usdc = new MockToken();
        for (uint256 j; j < 7; j++) enforcers[j] = address(new MockCode());
        MockFactory factory = new MockFactory(); router = new MockRouter(address(factory));
        gate = new PurchaseGateV1(address(new MockManager()), address(jpyc), address(usdc), implementation, address(router), address(factory), enforcers);
        p = I.Policy(owner, bytes32(uint256(1)), 1, uint64(block.timestamp), uint64(block.timestamp+86400), uint64(block.timestamp), 3600,
            1500e18, 10000e18, 0, 0, keccak256("risk-v1"), keccak256("binding"), 0, 300, 255, vm.addr(M_KEY), vm.addr(R_KEY), vm.addr(H_KEY), vm.addr(P_KEY));
        shops.push(I.Merchant(keccak256("shop"), merchant));
        assets.push(I.AssetLimit(address(usdc), 10_000_000, 100_000_000));
        senders.push(address(this));
        p.merchantSetHash = keccak256(abi.encode(shops)); p.assetLimitsHash = keccak256(abi.encode(assets)); p.relayerSetHash = keccak256(abi.encode(senders));
        address first = address(jpyc) < address(usdc) ? address(jpyc) : address(usdc);
        address second = first == address(jpyc) ? address(usdc) : address(jpyc);
        grants.push(_grant(first)); grants.push(_grant(second));
        _register(false);
        jpyc.mint(owner, 100000e18); usdc.mint(owner, 100_000_000);
    }
    function _sign(uint256 key, bytes32 structHash) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gate.domainDigest(structHash)); return abi.encodePacked(r, s, v);
    }
    function _parent(address token) internal view returns (D.Delegation memory d) {
        D.Caveat[] memory c = new D.Caveat[](5);
        c[0] = D.Caveat(enforcers[0], abi.encodePacked(token, type(uint256).max, type(uint256).max, uint256(p.periodStart)), "");
        c[1] = D.Caveat(enforcers[1], abi.encodePacked(address(gate)), "");
        c[2] = D.Caveat(enforcers[2], abi.encodePacked(uint128(0), uint128(p.validUntil)), "");
        c[3] = D.Caveat(enforcers[3], abi.encode(uint256(0)), "");
        c[4] = D.Caveat(enforcers[4], abi.encode(uint256(0)), "");
        return D.Delegation(agent, owner, bytes32(type(uint256).max), c, 0, hex"01");
    }
    function _grant(address token) internal view returns (I.GrantBinding memory) {
        bytes32[] memory hashes = new bytes32[](1); hashes[0] = D.hash(_parent(token));
        return I.GrantBinding(p.policyId, p.version, agent, token, keccak256(abi.encode(hashes)), p.validUntil);
    }
    function _register(bool update) internal {
        bytes32[] memory hashes = new bytes32[](grants.length);
        for (uint256 j; j < grants.length; j++) { grants[j].policyVersion = p.version; hashes[j] = GateHash.hash(grants[j]); }
        uint64 nonce = gate.ownerNonce(owner); uint64 until = uint64(block.timestamp+300);
        bytes memory sig = _sign(OWNER_KEY, keccak256(abi.encode(GateHash.POLICYREGISTRATION, GateHash.hash(p), keccak256(abi.encode(hashes)), nonce, until)));
        if (update) gate.updatePolicy(p, shops, assets, grants, senders, nonce, until, sig);
        else gate.registerPolicy(p, shops, assets, grants, senders, nonce, until, sig);
    }
    function _context(address token, address payee, uint256 amount) internal returns (bytes memory encoded, bytes32 leafHash) {
        D.Delegation[] memory chain = new D.Delegation[](2); chain[1] = _parent(token);
        D.Caveat[] memory c = new D.Caveat[](2);
        c[0] = D.Caveat(enforcers[5], abi.encodePacked(token, amount), "");
        c[1] = D.Caveat(enforcers[6], abi.encode(uint256(4), payee), "");
        chain[0] = D.Delegation(address(gate), agent, D.hash(chain[1]), c, ++sequence, hex"01");
        return (abi.encode(chain), D.hash(chain[0]));
    }
    function _case(uint256 amount, bool funded) internal returns (OrderCase memory c) {
        c.o = I.PurchaseOrder(bytes32(++sequence), bytes32(++sequence), p.policyId, p.version, uint64((block.timestamp-p.periodStart)/p.periodSeconds), owner, agent, shops[0].shopIdHash, merchant, address(jpyc), amount, keccak256("basket"), 0, 0, uint64(block.timestamp+300));
        if (funded) {
            c.route = abi.encodePacked(address(jpyc), uint24(3000), address(usdc));
            c.f = I.Funding(address(usdc), 10_000_000, amount, address(gate.fundingAdapter()), keccak256(c.route), c.o.validUntil);
            (c.funding, c.i.fundingLeafHash) = _context(address(usdc), address(gate), c.f.maxInput);
        }
        c.o.fundingHash = GateHash.hash(c.f);
        c.o.requirementsHash = keccak256(abi.encode(block.chainid, address(jpyc), merchant, amount, keccak256("exact"), keccak256("erc7710"), address(gate), uint32(1)));
        (c.payment, c.i.paymentLeafHash) = _context(address(jpyc), merchant, amount);
        _resign(c);
    }
    function _resign(OrderCase memory c) internal {
        c.i.orderHash = gate.domainDigest(GateHash.hash(c.o)); c.i.validUntil = c.o.validUntil;
        c.r = I.RiskStamp(gate.domainDigest(GateHash.hash(c.i)), keccak256("clear"), p.riskRulesHash, 0, uint64(block.timestamp), uint64(block.timestamp+60));
        c.sig.merchant = _sign(M_KEY, GateHash.hash(c.o)); c.sig.agent = _sign(AGENT_KEY, GateHash.hash(c.i)); c.sig.risk = _sign(R_KEY, GateHash.hash(c.r));
        if (c.f.token != address(0)) {
            c.price = I.PriceStamp(c.i.orderHash, address(usdc), 10_000_000, keccak256("external reference"), uint64(block.timestamp), uint64(block.timestamp+60));
            c.sig.price = _sign(P_KEY, GateHash.hash(c.price));
        }
    }
    function _approve(OrderCase memory c, uint32 mask) internal {
        c.h = I.HumanApproval(bytes32(++sequence), c.r.intentHash, c.r.riskDigest, p.identityBindingId, mask, uint64(block.timestamp), uint64(block.timestamp+120));
        c.sig.human = _sign(H_KEY, GateHash.hash(c.h));
    }
    function _execute(OrderCase memory c) internal returns (I.PurchaseResult memory) {
        return gate.executePurchase(c.o, c.f, c.i, c.payment, c.funding, c.r, c.price, c.h, c.sig, c.route);
    }
    function _spent() internal view returns (uint256) { return gate.spentJpyc(owner, p.policyId, 0); }
}
