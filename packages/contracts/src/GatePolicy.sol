// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPurchaseGateV1 as I} from "./IPurchaseGateV1.sol";
import {GateHash} from "./GateHash.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PurchaseValidatorV1} from "./PurchaseValidatorV1.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

abstract contract GatePolicy is I, EIP712, ReentrancyGuard {
    address public immutable settlementToken;
    address public immutable inputToken;
    address public immutable accountImplementation;
    PurchaseValidatorV1 public immutable validator;
    mapping(address => Policy) internal policies;
    mapping(address => bytes32) public canonicalPolicyId;
    mapping(address => bool) public active;
    mapping(address => uint64) public ownerNonce;
    mapping(address => uint64) public merchantNonce;
    mapping(address => mapping(uint64 => mapping(bytes32 => bool))) internal merchants;
    mapping(address => mapping(uint64 => mapping(address => bool))) internal relayers;
    mapping(address => mapping(uint64 => mapping(address => AssetLimit))) internal limits;
    mapping(address => mapping(uint64 => mapping(address => mapping(address => GrantBinding)))) internal bindings;
    mapping(address => mapping(bytes32 => bytes32)) public override paidOrderHash;
    mapping(address => mapping(bytes32 => bool)) public override isOrderCancelled;
    mapping(address => mapping(bytes32 => mapping(bytes32 => bool))) public override isRevisionInvalidated;
    mapping(address => mapping(bytes32 => bool)) public override isApprovalUsed;
    mapping(address => mapping(bytes32 => mapping(uint64 => uint256))) public override spentJpyc;
    mapping(address => mapping(bytes32 => mapping(uint64 => mapping(address => uint256)))) public override spentInput;

    constructor(address jpyc, address usdc, address implementation, address[7] memory enforcers_) EIP712("JPYC PurchaseGate", "1") {
        if (jpyc == usdc || jpyc.code.length == 0 || usdc.code.length == 0 || implementation.code.length == 0) revert UnsupportedConfiguration();
        settlementToken = jpyc; inputToken = usdc; accountImplementation = implementation;
        validator = new PurchaseValidatorV1(jpyc, usdc, enforcers_);
    }

    function policy(address account) external view returns (Policy memory) { return policies[account]; }
    function grant(address account, uint64 version, address agent, address token) external view returns (GrantBinding memory) { return bindings[account][version][agent][token]; }
    function domainDigest(bytes32 structHash) external view returns (bytes32) { return _hashTypedDataV4(structHash); }

    function _signature(address signer, bytes32 structHash, bytes memory signature, bytes32 role) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        // A 7702 EOA still owns its signing key; ERC-1271 is supported for the pinned account.
        if (signer == address(0) || !((error == ECDSA.RecoverError.NoError && recovered == signer) || SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature))) revert InvalidSignature(role);
    }
    function _deadline(uint64 until) internal view { if (until <= block.timestamp) revert DeadlineExpired(); }
    function _account(address account) internal view {
        if (keccak256(account.code) != keccak256(abi.encodePacked(hex"ef0100", accountImplementation))) revert UnsupportedConfiguration();
    }
    function _owner(address account, uint64 nonce, uint64 until, bytes32 h, bytes calldata signature) internal {
        _deadline(until);
        if (nonce != ownerNonce[account]) revert InvalidSignature("nonce");
        _signature(account, h, signature, "owner");
        ownerNonce[account]++;
    }
    function registerPolicy(Policy calldata p, Merchant[] calldata shops, AssetLimit[] calldata assets, GrantBinding[] calldata grants, address[] calldata senders, uint64 nonce, uint64 until, bytes calldata signature) external override nonReentrant {
        if (canonicalPolicyId[p.account] != bytes32(0) || p.version != 1) revert UnsupportedConfiguration();
        _configure(p, shops, assets, grants, senders, nonce, until, signature);
    }
    function updatePolicy(Policy calldata p, Merchant[] calldata shops, AssetLimit[] calldata assets, GrantBinding[] calldata grants, address[] calldata senders, uint64 nonce, uint64 until, bytes calldata signature) external override nonReentrant {
        Policy storage old = policies[p.account];
        if (canonicalPolicyId[p.account] != p.policyId || p.policyId == bytes32(0) || p.version != old.version + 1 || p.periodStart != old.periodStart || p.periodSeconds != old.periodSeconds) revert UnsupportedConfiguration();
        _configure(p, shops, assets, grants, senders, nonce, until, signature);
    }
    function _configure(Policy calldata p, Merchant[] calldata shops, AssetLimit[] calldata assets, GrantBinding[] calldata grants, address[] calldata senders, uint64 nonce, uint64 until, bytes calldata signature) private {
        _account(p.account);
        bytes32 checkedGrantsHash = validator.configuration(p, shops, assets, grants, senders);
        for (uint256 j; j < grants.length; j++) {
            GrantBinding calldata g = grants[j];
            bindings[p.account][p.version][g.agent][g.token] = g;
        }
        _owner(p.account, nonce, until, keccak256(abi.encode(GateHash.POLICYREGISTRATION, GateHash.hash(p), checkedGrantsHash, nonce, until)), signature);
        for (uint256 j; j < shops.length; j++) merchants[p.account][p.version][keccak256(abi.encode(shops[j]))] = true;
        for (uint256 j; j < assets.length; j++) limits[p.account][p.version][assets[j].token] = assets[j];
        for (uint256 j; j < senders.length; j++) relayers[p.account][p.version][senders[j]] = true;
        canonicalPolicyId[p.account] = p.policyId;
        policies[p.account] = p;
        active[p.account] = true;
        emit PolicyRegistered(p.account, p.policyId, p.version);
    }
    function revokePolicy(address account, bytes32 id, uint64 nonce, uint64 until, bytes calldata signature) external override nonReentrant {
        if (canonicalPolicyId[account] != id || id == bytes32(0)) revert UnsupportedConfiguration();
        _owner(account, nonce, until, keccak256(abi.encode(GateHash.REVOKE, account, id, nonce, until)), signature);
        active[account] = false;
        emit PolicyRevoked(account, id);
    }
    function cancelOrder(address account, bytes32 id, uint64 nonce, uint64 until, bytes calldata signature) external override nonReentrant {
        if (id == bytes32(0) || paidOrderHash[account][id] != bytes32(0)) revert OrderAlreadyPaid();
        _owner(account, nonce, until, keccak256(abi.encode(GateHash.CANCEL, account, id, nonce, until)), signature);
        isOrderCancelled[account][id] = true;
        emit OrderCancellation(account, id);
    }
    function invalidateRevision(address account, bytes32 id, bytes32 orderId, bytes32 revisionId, uint64 nonce, uint64 until, bytes calldata signature) external override nonReentrant {
        _deadline(until);
        if (canonicalPolicyId[account] != id || id == bytes32(0) || merchantNonce[account] != nonce) revert UnsupportedConfiguration();
        if (paidOrderHash[account][orderId] != bytes32(0)) revert OrderAlreadyPaid();
        _signature(policies[account].merchantSigner, keccak256(abi.encode(GateHash.INVALIDATEREVISION, account, id, orderId, revisionId, nonce, until)), signature, "merchant");
        merchantNonce[account]++;
        isRevisionInvalidated[account][orderId][revisionId] = true;
        emit RevisionInvalidation(account, orderId, revisionId);
    }
}
