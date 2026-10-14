// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Wire-compatible with MetaMask delegation-framework bff4b08f.
/// Signatures and mutable args are deliberately excluded from official struct hashes.
library DelegationCodec {
    struct Caveat { address enforcer; bytes terms; bytes args; }
    struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }
    bytes32 internal constant CAVEAT = keccak256("Caveat(address enforcer,bytes terms)");
    bytes32 internal constant DELEGATION = keccak256("Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)");

    function hash(Delegation memory d) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](d.caveats.length);
        for (uint256 j; j < hashes.length; j++) {
            hashes[j] = keccak256(abi.encode(CAVEAT, d.caveats[j].enforcer, keccak256(d.caveats[j].terms)));
        }
        return keccak256(abi.encode(DELEGATION, d.delegate, d.delegator, d.authority, keccak256(abi.encodePacked(hashes)), d.salt));
    }
}

interface IDelegationManagerV1 {
    function redeemDelegations(bytes[] calldata contexts, bytes32[] calldata modes, bytes[] calldata executions) external;
}
