// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPurchaseGateV1 as I} from "./IPurchaseGateV1.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IPolicyReader { function policy(address account) external view returns (I.Policy memory); }

/// @notice Additional per-connection limits; never custody or transfer funds.
/// The stable connection ID, not its replaceable execution key or revision,
/// indexes spending. A global policy update cannot reset either ledger.
contract AgentPermissionRegistry is EIP712 {
    struct Permission {
        address account;
        bytes32 policyId;
        bytes32 connectionId;
        uint64 revision;
        address agent;
        uint64 validUntil;
        uint256 perOrder;
        uint256 perPeriod;
        bytes32 merchantsHash;
    }
    bytes32 public constant PERMISSION_TYPEHASH = keccak256("AgentPermission(address account,bytes32 policyId,bytes32 connectionId,uint64 revision,address agent,uint64 validUntil,uint256 perOrder,uint256 perPeriod,bytes32 merchantsHash,uint64 nonce,uint64 deadline)");
    bytes32 public constant REVOKE_TYPEHASH = keccak256("RevokeAgent(address account,bytes32 connectionId,uint64 nonce,uint64 deadline)");
    address public immutable gate;
    mapping(address => uint64) public nonces;
    mapping(address => mapping(bytes32 => Permission)) public permissions;
    mapping(address => mapping(bytes32 => bool)) public active;
    mapping(address => mapping(address => bytes32)) public connectionForAgent;
    mapping(address => mapping(bytes32 => mapping(uint64 => uint256))) public spent;
    mapping(address => mapping(bytes32 => mapping(uint64 => mapping(bytes32 => bool)))) private merchants;
    error InvalidPermission();
    error InvalidOwnerSignature();
    error AgentInactive();
    event PermissionChanged(address indexed account, bytes32 indexed connectionId, address indexed agent, uint64 revision);
    event PermissionRevoked(address indexed account, bytes32 indexed connectionId);

    constructor() EIP712("yours Agent Permissions", "1") { gate = msg.sender; }
    function domainDigest(bytes32 hash) external view returns (bytes32) { return _hashTypedDataV4(hash); }

    function configure(Permission calldata p, I.Merchant[] calldata allowed, uint64 nonce, uint64 deadline, bytes calldata signature) external {
        I.Policy memory global = IPolicyReader(gate).policy(p.account);
        Permission storage old = permissions[p.account][p.connectionId];
        if (p.account == address(0) || p.agent == address(0) || p.agent == p.account || p.connectionId == 0 || p.policyId == 0 || global.policyId != p.policyId || p.revision != old.revision + 1 || p.validUntil <= block.timestamp || p.validUntil > global.validUntil || allowed.length > 64 || keccak256(abi.encode(allowed)) != p.merchantsHash) revert InvalidPermission();
        if (old.revision != 0 && old.policyId != p.policyId) revert InvalidPermission();
        bytes32 assigned = connectionForAgent[p.account][p.agent];
        if (assigned != 0 && assigned != p.connectionId) revert InvalidPermission();
        _owner(p.account, nonce, deadline, keccak256(abi.encode(PERMISSION_TYPEHASH, p, nonce, deadline)), signature);
        if (old.agent != address(0)) delete connectionForAgent[p.account][old.agent];
        for (uint256 j; j < allowed.length; j++) {
            if (allowed[j].shopIdHash == 0 || allowed[j].payTo == address(0) || allowed[j].payTo == p.account || allowed[j].payTo == gate) revert InvalidPermission();
            merchants[p.account][p.connectionId][p.revision][keccak256(abi.encode(allowed[j]))] = true;
        }
        permissions[p.account][p.connectionId] = p;
        active[p.account][p.connectionId] = true;
        connectionForAgent[p.account][p.agent] = p.connectionId;
        emit PermissionChanged(p.account, p.connectionId, p.agent, p.revision);
    }
    function revoke(address account, bytes32 connectionId, uint64 nonce, uint64 deadline, bytes calldata signature) external {
        if (permissions[account][connectionId].revision == 0) revert InvalidPermission();
        _owner(account, nonce, deadline, keccak256(abi.encode(REVOKE_TYPEHASH, account, connectionId, nonce, deadline)), signature);
        active[account][connectionId] = false;
        emit PermissionRevoked(account, connectionId);
    }
    function consume(I.PurchaseOrder calldata o) external returns (uint32 reasons) {
        if (msg.sender != gate) revert InvalidPermission();
        bytes32 id = connectionForAgent[o.account][o.agent];
        Permission storage p = permissions[o.account][id];
        if (id == 0 || !active[o.account][id] || p.policyId != o.policyId || p.agent != o.agent || p.validUntil < o.validUntil || p.validUntil <= block.timestamp) revert AgentInactive();
        uint256 after_ = spent[o.account][id][o.periodIndex] + o.settlementAmount;
        if (o.settlementAmount > p.perOrder) reasons |= 1;
        if (after_ > p.perPeriod) reasons |= 2;
        if (!merchants[o.account][id][p.revision][keccak256(abi.encode(I.Merchant(o.shopIdHash, o.payTo)))]) reasons |= 4;
        spent[o.account][id][o.periodIndex] = after_;
    }
    function _owner(address account, uint64 nonce, uint64 deadline, bytes32 hash, bytes calldata signature) private {
        if (deadline <= block.timestamp || nonces[account] != nonce) revert InvalidOwnerSignature();
        bytes32 digest = _hashTypedDataV4(hash);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (!((error == ECDSA.RecoverError.NoError && recovered == account) || SignatureChecker.isValidERC1271SignatureNow(account, digest, signature))) revert InvalidOwnerSignature();
        nonces[account]++;
    }
}
