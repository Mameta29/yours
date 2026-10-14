"""AP2 signing with non-exportable KMS keys; verification uses the pinned SDK."""
import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Protocol

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from jwcrypto.jwk import JWK


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def hash_b64(value: str) -> str:
    return b64(hashlib.sha256(value.encode()).digest())


class Signer(Protocol):
    kid: str

    def sign(self, message: bytes) -> bytes: ...
    def public_jwk(self) -> dict: ...


class LocalSigner:
    """Development/test only. Persistent local key files are never committed."""
    def __init__(self, kid: str, key=None):
        self.kid = kid
        self.key = key or ec.generate_private_key(ec.SECP256R1())

    @classmethod
    def load(cls, path: str, kid: str):
        if os.environ.get("ENVIRONMENT") == "production":
            raise RuntimeError("Local private keys are forbidden in production")
        file = Path(path)
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not file.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            try:
                fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
            except FileExistsError:
                pass
        return cls(kid, serialization.load_pem_private_key(file.read_bytes(), password=None))

    def public_jwk(self) -> dict:
        key = json.loads(JWK.from_pyca(self.key.public_key()).export_public())
        return {**key, "kid": self.kid, "alg": "ES256", "use": "sig"}

    def sign(self, message: bytes) -> bytes:
        r, s = utils.decode_dss_signature(self.key.sign(message, ec.ECDSA(hashes.SHA256())))
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


class KmsSigner:
    def __init__(self, key_version: str, kid: str):
        from google.cloud import kms
        self.client = kms.KeyManagementServiceClient()
        self.name = key_version
        self.kid = kid
        response = self.client.get_public_key(request={"name": key_version})
        if response.algorithm.name != "EC_SIGN_P256_SHA256":
            raise ValueError("AP2 requires a P-256 key")
        self.key = serialization.load_pem_public_key(response.pem.encode())

    def public_jwk(self) -> dict:
        return {**json.loads(JWK.from_pyca(self.key).export_public()), "kid": self.kid, "alg": "ES256", "use": "sig"}

    def sign(self, message: bytes) -> bytes:
        from google.cloud import kms
        digest = hashlib.sha256(message).digest()
        response = self.client.asymmetric_sign(request={"name": self.name, "digest": kms.Digest(sha256=digest)})
        # Verify locally before emitting a signature, including transit integrity.
        self.key.verify(response.signature, digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        r, s = utils.decode_dss_signature(response.signature)
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def sign_jwt(payload: dict, signer: Signer, typ: str = "dc+sd-jwt") -> str:
    header = b64(json.dumps({"alg": "ES256", "kid": signer.kid, "typ": typ}, separators=(",", ":")).encode())
    content = b64(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode())
    message = f"{header}.{content}"
    return f"{message}.{b64(signer.sign(message.encode()))}"


def issue_open(payload: dict, signer: Signer) -> str:
    # RFC 9901 array-element disclosure. KMS signs the commitment, while the
    # official SDK resolves and validates the disclosed mandate and its cnf.
    disclosure = b64(json.dumps([b64(os.urandom(32)), payload], ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode())
    jwt = sign_jwt({"delegate_payload": [{"...": hash_b64(disclosure)}], "_sd_alg": "sha-256"}, signer)
    return jwt + "~" + disclosure + "~"


def present_closed(open_token: str, payload: dict, signer: Signer, audience: str, nonce: str, now: int) -> str:
    if not audience or not nonce or "~~" in open_token:
        raise ValueError("Exactly one open mandate and a verifier challenge are required")
    canonical = open_token.rstrip("~") + "~"
    jwt = sign_jwt({"delegate_payload": [payload], "_sd_alg": "sha-256", "iat": now,
                    "aud": audience, "nonce": nonce, "sd_hash": hash_b64(canonical)},
                   signer, "kb+sd-jwt")
    return canonical.rstrip("~") + "~~" + jwt + "~"
