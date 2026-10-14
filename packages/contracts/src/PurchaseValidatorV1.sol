// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPurchaseGateV1 as I} from "./IPurchaseGateV1.sol";
import {GateHash} from "./GateHash.sol";
import {DelegationCodec as D} from "./DelegationCodec.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev Immutable, stateless validation companion, called with STATICCALL.
/// Splitting bytecode keeps the purchase entrypoint under the EIP-170 size limit.
/// It has no funds, signatures, execution privileges, upgrades, or delegatecall.
contract PurchaseValidatorV1 {
    address public immutable gate;
    address public immutable settlementToken;
    address public immutable inputToken;
    address[7] public enforcers;
    constructor(address jpyc, address usdc, address[7] memory e) {
        gate = msg.sender; settlementToken = jpyc; inputToken = usdc;
        for (uint256 j; j < e.length; j++) {
            if (e[j].code.length == 0) revert I.UnsupportedConfiguration();
            for (uint256 k; k < j; k++) if (e[j] == e[k]) revert I.UnsupportedConfiguration();
        }
        enforcers = e;
    }
    function checkSignature(address signer, bytes32 digest, bytes calldata signature, bytes32 role) external view {
        // A 7702 EOA still owns its signing key. Contract accounts may use ERC-1271.
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (signer == address(0) || !((error == ECDSA.RecoverError.NoError && recovered == signer) || SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature))) revert I.InvalidSignature(role);
    }
    function configuration(I.Policy calldata p, I.Merchant[] calldata shops, I.AssetLimit[] calldata assets, I.GrantBinding[] calldata grants, address[] calldata senders) external view returns (bytes32) {
        if (p.policyId == bytes32(0) || p.identityBindingId == bytes32(0) || p.riskRulesHash == bytes32(0) || p.periodSeconds == 0 || p.periodStart > p.validAfter || p.validAfter >= p.validUntil || p.validUntil <= block.timestamp || p.humanOverrideMask > 255 || p.autoMaxPremiumBps > 10000 || shops.length > 64 || assets.length > 1 || grants.length == 0 || grants.length > 16 || senders.length == 0 || senders.length > 8) revert I.UnsupportedConfiguration();
        address[4] memory signers = [p.merchantSigner, p.riskSigner, p.humanSigner, p.priceSigner];
        for (uint256 j; j < 4; j++) {
            if (signers[j] == address(0) || signers[j] == p.account) revert I.UnsupportedConfiguration();
            for (uint256 k; k < j; k++) if (signers[j] == signers[k]) revert I.UnsupportedConfiguration();
        }
        if (keccak256(abi.encode(shops)) != p.merchantSetHash || keccak256(abi.encode(assets)) != p.assetLimitsHash || keccak256(abi.encode(senders)) != p.relayerSetHash) revert I.UnsupportedConfiguration();
        bytes32[] memory hashes = new bytes32[](grants.length);
        for (uint256 j; j < grants.length; j++) {
            I.GrantBinding calldata g = grants[j];
            if (g.policyId != p.policyId || g.policyVersion != p.version || g.agent == address(0) || g.agent == p.account || (g.token != settlementToken && g.token != inputToken) || g.grantChainHash == bytes32(0) || g.validUntil < p.validUntil) revert I.UnsupportedConfiguration();
            for (uint256 k; k < 4; k++) if (g.agent == signers[k]) revert I.UnsupportedConfiguration();
            if (j > 0 && !(uint160(g.agent) > uint160(grants[j-1].agent) || (g.agent == grants[j-1].agent && uint160(g.token) > uint160(grants[j-1].token)))) revert I.UnsupportedConfiguration();
            hashes[j] = GateHash.hash(g);
        }
        for (uint256 j; j < shops.length; j++) {
            I.Merchant calldata s = shops[j];
            if (s.shopIdHash == bytes32(0) || s.payTo == address(0) || s.payTo == p.account || s.payTo == gate) revert I.UnsupportedConfiguration();
            if (j > 0 && !(uint256(s.shopIdHash) > uint256(shops[j-1].shopIdHash) || (s.shopIdHash == shops[j-1].shopIdHash && uint160(s.payTo) > uint160(shops[j-1].payTo)))) revert I.UnsupportedConfiguration();
        }
        for (uint256 j; j < assets.length; j++) {
            if (assets[j].token != inputToken) revert I.UnsupportedConfiguration();
        }
        for (uint256 j; j < senders.length; j++) {
            if (senders[j] == address(0) || (j > 0 && uint160(senders[j]) <= uint160(senders[j-1]))) revert I.UnsupportedConfiguration();
        }
        return keccak256(abi.encode(hashes));
    }
    function validateContext(bytes calldata context, address account, address agent, address token, address payee, uint256 amount, bytes32 leafHash, bytes32 grantHash) external view {
        if (context.length == 0 || context.length > 8192) revert I.InvalidContext();
        D.Delegation[] memory chain = abi.decode(context, (D.Delegation[]));
        if (chain.length < 2 || chain.length > 8 || keccak256(abi.encode(chain)) != keccak256(context)) revert I.InvalidContext();
        if (chain[0].delegate != gate || chain[0].delegator != agent || D.hash(chain[0]) != leafHash || chain[chain.length-1].delegator != account || chain[chain.length-1].authority != bytes32(type(uint256).max)) revert I.InvalidContext();
        bytes32[] memory parents = new bytes32[](chain.length-1);
        bool gateBound; bool amountBound; bool payeeBound;
        for (uint256 j; j < chain.length; j++) {
            if (chain[j].signature.length == 0 || chain[j].caveats.length > 16) revert I.InvalidContext();
            if (j > 0) { parents[j-1] = D.hash(chain[j]); if (chain[j].delegator == agent) revert I.InvalidContext(); }
            if (j+1 < chain.length && (chain[j].authority != D.hash(chain[j+1]) || chain[j].delegator != chain[j+1].delegate)) revert I.InvalidContext();
            for (uint256 k; k < chain[j].caveats.length; k++) {
                D.Caveat memory c = chain[j].caveats[k];
                if (c.args.length != 0) revert I.InvalidContext();
                bool known;
                for (uint256 n; n < enforcers.length; n++) if (c.enforcer == enforcers[n]) known = true;
                if (!known) revert I.InvalidContext();
                if (j > 0 && c.enforcer == enforcers[1]) {
                    if (keccak256(c.terms) != keccak256(abi.encodePacked(gate))) revert I.InvalidContext();
                    gateBound = true;
                }
                if (j == 0 && c.enforcer == enforcers[5] && keccak256(c.terms) == keccak256(abi.encodePacked(token, amount))) amountBound = true;
                if (j == 0 && c.enforcer == enforcers[6] && keccak256(c.terms) == keccak256(abi.encode(uint256(4), payee))) payeeBound = true;
            }
        }
        if (!gateBound || !amountBound || !payeeBound || keccak256(abi.encode(parents)) != grantHash) revert I.InvalidContext();
    }
}
