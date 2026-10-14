import json
import os
import time
import uuid
import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from yours_mandates.crypto import LocalSigner, sign_jwt
from yours_mandates.consent import consent_data, task_hash
from yours_mandates.service import Runtime, create_app

GATE = "0x" + "12" * 20


@pytest.fixture
def setup():
    wallet = Account.create()
    owner_id, connection_id, consent_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = int(time.time())
    task = {"merchant_id": "test-merchant", "merchant_name": "Merchant", "currency": "JPY", "max_amount": 1000,
            "items": [{"id": "tea", "title": "Tea", "quantity": 1}],
            "instrument_id": f"yours:80002:{wallet.address.lower()}:{connection_id}", "expires_at": now + 1800}
    nonce = "0x" + os.urandom(32).hex()
    pool = ConnectionPool(os.getenv("TEST_DATABASE_URL", "postgresql://localhost/yours_test"), min_size=0, max_size=3, kwargs={"row_factory": dict_row})
    issuer, holder, merchant = LocalSigner("issuer"), LocalSigner("holder"), LocalSigner("merchant")
    with pool.connection() as db:
        db.execute("INSERT INTO accounts(id,address,chain_id) VALUES(%s,%s,80002)", (owner_id, wallet.address.lower()))
        db.execute("INSERT INTO connections(id,account_id,name,provider,agent_address,status) VALUES(%s,%s,'Gemini','gemini',%s,'active')", (connection_id, owner_id, Account.create().address.lower()))
        db.execute("INSERT INTO permissions(connection_id,revision,document,owner_signature,status) VALUES(%s,1,%s,'test','active')", (connection_id, Jsonb({"validUntil": now + 3600})))
        db.execute("INSERT INTO policies(account_id,policy_id,revision,gate_address,token_address,token_decimals,currency,document) VALUES(%s,'test',1,%s,%s,18,'JPY',%s)", (owner_id, GATE, GATE, Jsonb({"status": "active", "validUntil": now + 3600})))
        db.execute("INSERT INTO task_consents(id,account_id,connection_id,task,task_hash,nonce,valid_until) VALUES(%s,%s,%s,%s,%s,%s,%s)", (consent_id, owner_id, connection_id, Jsonb(task), task_hash(task), nonce, now + 300))
    data = consent_data(wallet.address, str(connection_id), task_hash(task), nonce, now + 300, 80002, GATE)
    signature = "0x" + Account.sign_message(encode_typed_data(full_message=data), wallet.key).signature.hex()
    client = TestClient(create_app(Runtime(pool, issuer, holder, merchant.public_jwk(), 80002, GATE, "https://merchant.example")))
    yield {"client": client, "pool": pool, "wallet": wallet, "owner": owner_id, "connection": connection_id, "consent": consent_id, "task": task,
           "data": data, "signature": signature, "merchant": merchant}
    pool.close()


def issue(setup, signature=None):
    return setup["client"].post("/v1/issue", json={"consent_id": str(setup["consent"]), "signature": signature or setup["signature"]})


def test_issuer_requires_real_owner_proof_and_retries_are_idempotent(setup):
    first = issue(setup)
    assert first.status_code == 200, first.text
    assert "~~" not in first.json()["open_checkout"]
    assert issue(setup).json() == first.json()
    with setup["pool"].connection() as db:
        assert db.execute("SELECT count(*) AS n FROM mandates WHERE consent_id=%s", (setup["consent"],)).fetchone()["n"] == 1


def test_different_wallet_cannot_authorize_the_task(setup):
    signature = "0x" + Account.sign_message(encode_typed_data(full_message=setup["data"]), Account.create().key).signature.hex()
    assert issue(setup, signature).status_code == 422


def test_different_chain_signature_cannot_be_reused(setup):
    setup["data"]["domain"]["chainId"] = 1
    signature = "0x" + Account.sign_message(encode_typed_data(full_message=setup["data"]), setup["wallet"].key).signature.hex()
    assert issue(setup, signature).status_code == 422


def test_modified_task_and_paused_connection_are_rejected(setup):
    with setup["pool"].connection() as db:
        task = {**setup["task"], "max_amount": 2000}
        db.execute("UPDATE task_consents SET task=%s WHERE id=%s", (Jsonb(task), setup["consent"]))
    assert issue(setup).status_code == 422
    with setup["pool"].connection() as db:
        db.execute("UPDATE connections SET status='paused' WHERE id=%s", (setup["connection"],))
    assert issue(setup).status_code == 403


def test_expired_consent_is_not_authority(setup):
    with setup["pool"].connection() as db:
        db.execute("UPDATE task_consents SET valid_until=%s WHERE id=%s", (int(time.time()) - 1, setup["consent"]))
    assert issue(setup).status_code == 422


def test_presentation_is_bound_to_stored_checkout_and_issued_mandates(setup):
    issued = issue(setup).json()
    checkout_id = uuid.uuid4()
    checkout = {"id": str(checkout_id), "merchant": {"id": "test-merchant", "name": "Merchant"}, "ucp": {"version": "2026-08-25", "payment_handlers": {}},
                "line_items": [{"id": "line-1", "item": {"id": "tea", "title": "Tea", "price": 900}, "quantity": 1, "totals": [{"type": "total", "amount": 900}]}],
                "currency": "JPY", "status": "ready_for_complete", "totals": [{"type": "total", "amount": 900}], "links": [],
                "yours": {"nonce": "checkout-nonce", "audience": "https://merchant.example"}}
    jwt = sign_jwt(checkout, setup["merchant"], "JWT")
    with setup["pool"].connection() as db:
        db.execute("INSERT INTO merchant_sessions(id,merchant_id,kind,actor,platform_profile,ap2_required,status,document,expires_at) VALUES(%s,'test-merchant','checkout',%s,'https://platform.example',true,'ready_for_complete',%s,now()+interval '30 minutes')", (checkout_id, "agent:" + str(setup["connection"]), Jsonb(checkout)))
    request = {"mandate_id": issued["id"], "checkout_id": str(checkout_id), "checkout_jwt": jwt}
    presented = setup["client"].post("/v1/present", json=request)
    assert presented.status_code == 200, presented.text
    verified = setup["client"].post("/v1/verify", json={**request, "mandates": presented.json()})
    assert verified.status_code == 200, verified.text
    assert verified.json()["payment"]["payment_amount"]["amount"] == 900
    checkout["totals"][0]["amount"] = 999
    changed = {**request, "checkout_jwt": sign_jwt(checkout, setup["merchant"], "JWT")}
    assert setup["client"].post("/v1/present", json=changed).status_code == 422
    assert setup["client"].post("/v1/receipts", json={"intent_id": str(uuid.uuid4())}).status_code == 409
