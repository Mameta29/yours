"""Non-exportable Cloud HSM EVM endorsement; never available to the LLM."""
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_keys import keys
from eth_keys.constants import SECPK1_N
from eth_utils import keccak
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature


class KmsEvmSigner:
    def __init__(self, name):
        from google.cloud import kms
        self.client = kms.KeyManagementServiceClient()
        self.name = name
        response = self.client.get_public_key(request={"name": name})
        if response.algorithm.name != "EC_SIGN_SECP256K1_SHA256":
            raise ValueError("Expected EVM key")
        numbers = serialization.load_pem_public_key(response.pem.encode()).public_numbers()
        self.public = keys.PublicKey(numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big"))
        self.address = self.public.to_checksum_address()

    def sign(self, data):
        from google.cloud import kms
        import google_crc32c
        encoded = encode_typed_data(full_message=data)
        digest = keccak(b"\x19" + encoded.version + encoded.header + encoded.body)
        response = self.client.asymmetric_sign(request={"name": self.name, "digest": kms.Digest(sha256=digest), "digest_crc32c": google_crc32c.value(digest)})
        if not response.verified_digest_crc32c or response.signature_crc32c != google_crc32c.value(response.signature):
            raise ValueError("HSM integrity failure")
        r, s = decode_dss_signature(response.signature)
        if not 0 < r < SECPK1_N or not 0 < s < SECPK1_N:
            raise ValueError("Invalid EVM signature")
        s = min(s, SECPK1_N - s)
        for v in (0, 1):
            signature = keys.Signature(vrs=(v, r, s))
            if signature.recover_public_key_from_msg_hash(digest) == self.public:
                return "0x" + r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex() + bytes([v + 27]).hex()
        raise ValueError("HSM signer mismatch")


class LocalEvmSigner:
    def __init__(self, key):
        self.account = Account.from_key(key)
        self.address = self.account.address

    def sign(self, data):
        return "0x" + self.account.sign_message(encode_typed_data(full_message=data)).signature.hex()


def human_data(gate, chain_id, human):
    fields = [("approvalId", "bytes32"), ("intentHash", "bytes32"), ("riskDigest", "bytes32"),
              ("identityBindingId", "bytes32"), ("overrideMask", "uint32"), ("authenticatedAt", "uint64"), ("validUntil", "uint64")]
    return {"domain": {"name": "JPYC PurchaseGate", "version": "1", "chainId": chain_id, "verifyingContract": gate},
            "types": {"HumanApproval": [{"name": name, "type": kind} for name, kind in fields]}, "primaryType": "HumanApproval", "message": human}


def order_consent_data(gate, chain_id, account, proof):
    fields = [("account", "address"), ("intentHash", "bytes32"), ("riskDigest", "bytes32"), ("overrideMask", "uint32"), ("nonce", "bytes32"), ("validUntil", "uint64")]
    return {"domain": {"name": "yours Consent", "version": "1", "chainId": chain_id, "verifyingContract": gate},
            "types": {"OrderConsent": [{"name": name, "type": kind} for name, kind in fields]}, "primaryType": "OrderConsent",
            "message": {"account": account, **{name: proof[name] for name, _ in fields if name != "account"}}}
