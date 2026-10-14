"""Wallet proof checked at the trusted AP2 issuer, independently of the LLM."""
import hashlib
import json
import re
from eth_account import Account
from eth_account.messages import encode_typed_data


def task_hash(task: dict) -> str:
    # Task's schema has ASCII field names, integer amounts and no floating point.
    raw = json.dumps(task, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def connection_hash(connection_id: str) -> str:
    from eth_utils import keccak
    return "0x" + keccak(text=connection_id).hex()


def consent_data(account: str, connection_id: str, digest: str, nonce: str, valid_until: int, chain_id: int, gate: str) -> dict:
    return {
        "domain": {"name": "yours Consent", "version": "1", "chainId": chain_id, "verifyingContract": gate},
        "types": {"TaskConsent": [
            {"name": "account", "type": "address"}, {"name": "connectionId", "type": "bytes32"},
            {"name": "taskHash", "type": "bytes32"}, {"name": "nonce", "type": "bytes32"},
            {"name": "validUntil", "type": "uint64"},
        ]},
        "primaryType": "TaskConsent",
        "message": {"account": account, "connectionId": connection_hash(connection_id), "taskHash": "0x" + digest,
                    "nonce": nonce, "validUntil": valid_until},
    }


def verify_consent(row: dict, signature: str, chain_id: int, gate: str, now: int):
    if row["valid_until"] <= now or row["valid_until"] > now + 300:
        raise ValueError("consent_expired")
    if not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
        raise ValueError("invalid_owner_signature")
    if task_hash(row["task"]) != row["task_hash"]:
        raise ValueError("consent_modified")
    data = consent_data(row["address"], str(row["connection_id"]), row["task_hash"], row["nonce"], row["valid_until"], chain_id, gate)
    recovered = Account.recover_message(encode_typed_data(full_message=data), signature=signature)
    if recovered.lower() != row["address"].lower():
        raise ValueError("invalid_owner_signature")
