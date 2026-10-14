// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GateFixture} from "./GateFixture.sol";
import {PurchaseGateV1} from "../src/PurchaseGateV1.sol";
import {YoursPurchaseGate} from "../src/YoursPurchaseGate.sol";
import {AgentPermissionRegistry as Registry} from "../src/AgentPermissionRegistry.sol";
import {IPurchaseGateV1 as I} from "../src/IPurchaseGateV1.sol";
import {GateHash} from "../src/GateHash.sol";

contract YoursPurchaseGateTest is GateFixture {
    Registry registry;
    Registry.Permission permission;
    bytes32 constant CONNECTION = keccak256("gemini-connection");
    function _deployGate(address manager, address implementation, address factory) internal override returns (PurchaseGateV1) {
        return new YoursPurchaseGate(manager, address(jpyc), address(usdc), implementation, address(router), factory, enforcers);
    }
    function setUp() public override {
        super.setUp();
        registry = YoursPurchaseGate(address(gate)).agentPermissions();
        permission = Registry.Permission(owner, p.policyId, CONNECTION, 1, agent, p.validUntil, 800e18, 1200e18, keccak256(abi.encode(shops)));
        _configure();
    }
    function _registrySign(bytes32 hash) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, registry.domainDigest(hash)); return abi.encodePacked(r, s, v);
    }
    function _configure() internal {
        uint64 nonce = registry.nonces(owner); uint64 deadline = uint64(block.timestamp + 300);
        registry.configure(permission, shops, nonce, deadline, _registrySign(keccak256(abi.encode(registry.PERMISSION_TYPEHASH(), permission, nonce, deadline))));
    }
    function testAgentPerOrderLimitAndOneOrderException() public {
        OrderCase memory c = _case(900e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(1))); _execute(c);
        require(registry.spent(owner, CONNECTION, 0) == 0);
        _approve(c, 1); _execute(c);
        require(registry.spent(owner, CONNECTION, 0) == 900e18 && _spent() == 900e18);
        c = _case(400e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(c);
    }
    function testSharedBudgetStillAppliesWithLargerAgentBudget() public {
        permission.perOrder = 20000e18; permission.perPeriod = 20000e18; permission.revision++; _configure();
        p.autoPerOrderJpyc = 20000e18; p.version++; _register(true);
        OrderCase memory c = _case(11000e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(c);
    }
    function testRevisionAndReactivationNeverResetSpending() public {
        _execute(_case(800e18, false));
        permission.revision++; _configure();
        require(registry.spent(owner, CONNECTION, 0) == 800e18);
        uint64 nonce = registry.nonces(owner); uint64 deadline = uint64(block.timestamp + 100);
        registry.revoke(owner, CONNECTION, nonce, deadline, _registrySign(keccak256(abi.encode(registry.REVOKE_TYPEHASH(), owner, CONNECTION, nonce, deadline))));
        OrderCase memory c = _case(100e18, false); _approve(c, 255);
        vm.expectRevert(Registry.AgentInactive.selector); _execute(c);
        permission.revision++; _configure();
        c = _case(500e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(c);
    }
    function testKeyRotationKeepsBudgetAndDisablesOldExecutionKey() public {
        _execute(_case(800e18, false));
        permission.agent = vm.addr(909); permission.revision++; _configure();
        require(registry.connectionForAgent(owner, agent) == 0);
        require(registry.connectionForAgent(owner, permission.agent) == CONNECTION);
        require(registry.spent(owner, CONNECTION, 0) == 800e18);
        OrderCase memory c = _case(100e18, false);
        vm.expectRevert(Registry.AgentInactive.selector); _execute(c);
    }
    function testTransferFailureRollsBackBothBudgets() public {
        OrderCase memory c = _case(800e18, false); jpyc.setFailTransfer(true);
        vm.expectRevert(); _execute(c);
        require(registry.spent(owner, CONNECTION, 0) == 0 && _spent() == 0);
        jpyc.setFailTransfer(false); _execute(c);
        require(registry.spent(owner, CONNECTION, 0) == 800e18);
    }
    function testCannotConsumeOutsideGateOrForgeOwnerConsent() public {
        OrderCase memory c = _case(100e18, false);
        vm.expectRevert(Registry.InvalidPermission.selector); registry.consume(c.o);
        permission.revision++;
        uint64 nonce = registry.nonces(owner);
        vm.expectRevert(Registry.InvalidOwnerSignature.selector);
        registry.configure(permission, shops, nonce, uint64(block.timestamp + 100), hex"01");
    }
    function testConnectionSpecificMerchantRequiresExactOrderApproval() public {
        I.Merchant[] memory empty = new I.Merchant[](0);
        permission.revision++; permission.merchantsHash = keccak256(abi.encode(empty));
        uint64 nonce = registry.nonces(owner); uint64 deadline = uint64(block.timestamp + 100);
        registry.configure(permission, empty, nonce, deadline, _registrySign(keccak256(abi.encode(registry.PERMISSION_TYPEHASH(), permission, nonce, deadline))));
        OrderCase memory c = _case(100e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(4))); _execute(c);
        _approve(c, 4); _execute(c);
        c = _case(100e18, false);
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(4))); _execute(c);
    }
    function testFuzzAgentLimit(uint96 raw) public {
        uint256 amount = uint256(raw) % 1500e18 + 1;
        OrderCase memory c = _case(amount, false);
        if (amount > permission.perOrder) { vm.expectRevert(); _execute(c); require(registry.spent(owner, CONNECTION, 0) == 0); }
        else { _execute(c); require(registry.spent(owner, CONNECTION, 0) == amount); }
    }
    function testTwoAgentsHaveSeparateLedgersAndOneSharedBudget() public {
        _execute(_case(600e18, false));
        agent = vm.addr(707);
        grants.push(_grant(address(jpyc))); grants.push(_grant(address(usdc)));
        for (uint256 i; i < grants.length; i++) for (uint256 j = i + 1; j < grants.length; j++) {
            if (uint160(grants[i].agent) > uint160(grants[j].agent) || (grants[i].agent == grants[j].agent && uint160(grants[i].token) > uint160(grants[j].token))) {
                I.GrantBinding memory temp = grants[i]; grants[i] = grants[j]; grants[j] = temp;
            }
        }
        p.autoPerPeriodJpyc = 1000e18; p.version++; _register(true);
        bytes32 second = keccak256("second-connection");
        permission.connectionId = second; permission.revision = 1; permission.agent = agent; _configure();
        OrderCase memory c = _case(500e18, false); c.sig.agent = _sign(707, GateHash.hash(c.i));
        vm.expectRevert(abi.encodeWithSelector(I.HumanApprovalRequired.selector, uint32(2))); _execute(c);
        c = _case(400e18, false); c.sig.agent = _sign(707, GateHash.hash(c.i)); _execute(c);
        require(registry.spent(owner, CONNECTION, 0) == 600e18);
        require(registry.spent(owner, second, 0) == 400e18 && _spent() == 1000e18);
    }
}
