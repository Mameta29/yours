"""Private Cloud Run service. Only API/worker service accounts may invoke it.

The issuer independently verifies a fresh wallet signature before issuing AP2
authority. The agent service has neither invocation rights nor KMS signing roles.
"""
import base64
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .consent import verify_consent
from .crypto import Signer
from .protocol import Task, issue, present, verify, receipts

# The upstream SDK's development log can contain full mandates. Application
# audit stores references only; raw credentials never go to Cloud Logging.
import ap2.sdk.mandate as mandate_module
if hasattr(mandate_module, "LOG_FILE_PATH"):
    mandate_module.LOG_FILE_PATH = os.devnull


@dataclass
class Runtime:
    db: ConnectionPool
    issuer: Signer
    holder: Signer
    merchant_jwk: dict
    chain_id: int
    gate: str
    origin: str
    human: Any = None


class IssueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_id: uuid.UUID
    signature: str = Field(pattern=r"^0x[0-9a-fA-F]{130}$")


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mandate_id: uuid.UUID
    checkout_id: uuid.UUID
    checkout_jwt: str = Field(min_length=20, max_length=131072)


class VerifyRequest(CheckoutRequest):
    mandates: dict[str, str]


class ReceiptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent_id: uuid.UUID


class OrderApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approval_id: uuid.UUID
    signature: str = Field(pattern=r"^0x[0-9a-fA-F]{130}$")


def error(code: str, status=422):
    raise HTTPException(status_code=status, detail=code)


def audit(db, account, action, resource, data=None):
    db.execute("INSERT INTO audit_events(account_id,actor,action,resource_id,data) VALUES(%s,'mandates-service',%s,%s,%s)",
               (account, action, str(resource), Jsonb(data or {})))


def load_checkout(db, request: CheckoutRequest):
    mandate = db.execute("SELECT m.*,c.status,c.provider,c.ap2_public_jwk FROM mandates m JOIN connections c ON c.id=m.connection_id WHERE m.id=%s", (request.mandate_id,)).fetchone()
    if not mandate or mandate["revoked_at"] or mandate["expires_at"].timestamp() <= time.time() or mandate["status"] != "active":
        error("mandate_inactive", 403)
    checkout = db.execute("SELECT * FROM merchant_sessions WHERE id=%s AND kind='checkout'", (request.checkout_id,)).fetchone()
    if not checkout or checkout["actor"] != "agent:" + str(mandate["connection_id"]):
        error("checkout_not_found", 404)
    if checkout["status"] != "ready_for_complete" or checkout["expires_at"].timestamp() <= time.time():
        error("checkout_not_ready", 409)
    try:
        payload = json.loads(base64.urlsafe_b64decode(request.checkout_jwt.split(".")[1] + "=="))
    except (ValueError, IndexError):
        error("checkout_jwt_invalid")
    expected = {key: value for key, value in checkout["document"].items() if key != "ap2"}
    if payload != expected:
        error("checkout_jwt_mismatch")
    usage = db.execute("SELECT count(*)::int AS total_uses,coalesce(sum(amount_minor),0)::bigint AS total_amount FROM mandate_consumptions WHERE mandate_id=%s", (request.mandate_id,)).fetchone()
    return mandate, checkout["document"], usage


def create_app(runtime: Runtime):
    app = FastAPI(title="yours private mandate authority", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ValueError)
    async def bad_value(_request, _error):
        # Do not return upstream crypto exception messages or token payloads.
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=422, content={"detail": "mandate_or_consent_invalid"})

    @app.get("/healthz")
    def health():
        return {"ok": True, "service": "yours-mandates"}

    @app.get("/v1/keys")
    def keys():
        return {"issuer": runtime.issuer.public_jwk(), "holder": runtime.holder.public_jwk()}

    @app.post("/v1/issue")
    def issue_route(request: IssueRequest):
        with runtime.db.connection() as db, db.transaction():
            target = db.execute("SELECT account_id FROM task_consents WHERE id=%s", (request.consent_id,)).fetchone()
            if not target:
                error("consent_not_found", 404)
            db.execute("SELECT id FROM accounts WHERE id=%s FOR UPDATE", (target["account_id"],))
            row = db.execute("SELECT s.*,a.address,c.status,c.provider,c.ap2_public_jwk FROM task_consents s JOIN accounts a ON a.id=s.account_id JOIN connections c ON c.id=s.connection_id WHERE s.id=%s FOR UPDATE OF s", (request.consent_id,)).fetchone()
            if row["consumed_at"]:
                if row["owner_signature"] != request.signature:
                    error("consent_already_used", 409)
                old = db.execute("SELECT id,open_checkout,open_payment FROM mandates WHERE consent_id=%s", (request.consent_id,)).fetchone()
                return {**old, "id": str(old["id"])}
            if row["status"] != "active":
                error("permission_inactive", 403)
            verify_consent(row, request.signature, runtime.chain_id, runtime.gate, int(time.time()))
            task = Task(**row["task"])
            # The signed task is also bound to this owner's specific instrument.
            expected = f"yours:{runtime.chain_id}:{row['address']}:{row['connection_id']}"
            if task.instrument_id != expected:
                error("instrument_mismatch")
            permission = db.execute("SELECT document,status FROM permissions WHERE connection_id=%s", (row["connection_id"],)).fetchone()
            policy = db.execute("SELECT document FROM policies WHERE account_id=%s", (row["account_id"],)).fetchone()
            if not permission or not policy or permission["status"] != "active" or policy["document"]["status"] != "active" or task.expires_at > min(permission["document"]["validUntil"], policy["document"]["validUntil"]):
                error("task_outlives_permission", 403)
            holder = runtime.holder.public_jwk() if row["provider"] == "gemini" else row["ap2_public_jwk"]
            if not holder:
                error("holder_key_missing", 409)
            tokens = issue(task, holder, runtime.issuer)
            mandate_id = uuid.uuid4()
            db.execute("INSERT INTO mandates(id,account_id,connection_id,task,task_hash,open_checkout,open_payment,expires_at,consent_id) VALUES(%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s),%s)",
                       (mandate_id, row["account_id"], row["connection_id"], Jsonb(row["task"]), row["task_hash"], tokens["open_checkout"], tokens["open_payment"], task.expires_at, request.consent_id))
            db.execute("UPDATE task_consents SET consumed_at=now(),owner_signature=%s WHERE id=%s", (request.signature, request.consent_id))
            audit(db, row["account_id"], "mandate.issued", mandate_id, {"taskHash": row["task_hash"], "connectionId": str(row["connection_id"])})
            return {"id": str(mandate_id), **tokens}

    @app.post("/v1/present")
    def present_route(request: CheckoutRequest):
        with runtime.db.connection() as db:
            mandate, checkout, usage = load_checkout(db, request)
            if mandate["provider"] != "gemini":
                error("external_agent_must_sign_its_own_presentation", 403)
            tokens = present(mandate, request.checkout_jwt, checkout, runtime.holder, mandate["task"]["instrument_id"], checkout["yours"]["audience"], checkout["yours"]["nonce"])
            # An authenticated caller still cannot ask the holder to accept an
            # altered/out-of-scope merchant checkout. Verify before returning.
            verify(tokens, request.checkout_jwt, runtime.issuer.public_jwk(), runtime.merchant_jwk, checkout["yours"]["audience"], checkout["yours"]["nonce"], mandate["task"]["instrument_id"], usage)
            return tokens

    @app.post("/v1/verify")
    def verify_route(request: VerifyRequest):
        with runtime.db.connection() as db:
            mandate, checkout, usage = load_checkout(db, request)
            for kind in ("checkout", "payment"):
                if request.mandates.get(kind + "_mandate", "").split("~~")[0].rstrip("~") != mandate["open_" + kind].rstrip("~"):
                    error("mandate_authority_mismatch")
            return verify(request.mandates, request.checkout_jwt, runtime.issuer.public_jwk(), runtime.merchant_jwk, checkout["yours"]["audience"], checkout["yours"]["nonce"], mandate["task"]["instrument_id"], usage)

    @app.post("/v1/receipts")
    def receipt_route(request: ReceiptRequest):
        with runtime.db.connection() as db:
            row = db.execute("SELECT i.*,c.verified,o.id AS order_id FROM intents i JOIN mandate_consumptions c ON c.intent_id=i.id JOIN merchant_orders o ON o.session_id::text=i.checkout_id WHERE i.id=%s", (request.intent_id,)).fetchone()
            if not row or row["state"] != "confirmed" or not row["transaction_hash"]:
                error("settlement_not_confirmed", 409)
            return receipts(row["verified"], str(row["order_id"]), row["transaction_hash"], runtime.origin, runtime.issuer)

    @app.post("/v1/verify-execution")
    def verify_execution_route(request: ReceiptRequest):
        with runtime.db.connection() as db:
            row = db.execute("SELECT i.*,m.open_checkout,m.open_payment,m.revoked_at,m.expires_at AS mandate_expires,c.status FROM intents i JOIN mandate_consumptions mc ON mc.intent_id=i.id JOIN mandates m ON m.id=mc.mandate_id JOIN connections c ON c.id=i.connection_id WHERE i.id=%s", (request.intent_id,)).fetchone()
            if not row or row["state"] not in ("authorized", "approval_required") or row["status"] != "active" or row["revoked_at"] or min(row["expires_at"].timestamp(), row["mandate_expires"].timestamp()) <= time.time():
                error("execution_not_authorized", 403)
            snapshot = row["snapshot"]
            tokens = snapshot["mandates"]
            for kind in ("checkout", "payment"):
                if tokens.get(kind + "_mandate", "").split("~~")[0].rstrip("~") != row["open_" + kind].rstrip("~"):
                    error("mandate_authority_mismatch")
            checkout = snapshot["checkout"]
            return verify(tokens, snapshot["checkoutJwt"], runtime.issuer.public_jwk(), runtime.merchant_jwk, checkout["yours"]["audience"], checkout["yours"]["nonce"], snapshot["instrumentId"], {"total_uses": 0, "total_amount": 0})

    def approval_target(db, approval_id):
        target = db.execute("SELECT i.account_id FROM approvals a JOIN intents i ON i.id=a.intent_id WHERE a.id=%s", (approval_id,)).fetchone()
        if not target:
            error("approval_not_found", 404)
        db.execute("SELECT id FROM accounts WHERE id=%s FOR UPDATE", (target["account_id"],))
        row = db.execute("SELECT a.*,i.account_id,i.connection_id,i.snapshot_hash AS current_snapshot_hash,i.state,i.expires_at AS intent_expires,i.reasons,i.snapshot,e.envelope,e.payload,c.status,w.address,p.document AS policy,g.status AS permission_status,g.document AS permission FROM approvals a JOIN intents i ON i.id=a.intent_id JOIN accounts w ON w.id=i.account_id JOIN connections c ON c.id=i.connection_id JOIN policies p ON p.account_id=i.account_id JOIN permissions g ON g.connection_id=i.connection_id JOIN payment_envelopes e ON e.intent_id=i.id WHERE a.id=%s FOR UPDATE OF a,i", (approval_id,)).fetchone()
        now = int(time.time())
        if row["status"] != "active" or row["permission_status"] != "active" or row["policy"]["status"] != "active" or row["state"] not in ("approval_required", "authorized") or min(row["expires_at"].timestamp(), row["intent_expires"].timestamp(), row["permission"]["validUntil"], row["policy"]["validUntil"]) <= now:
            error("approval_inactive", 403)
        proof = row["proof"]
        info = row["payload"]["extensions"]["yours.purchase"]["info"]
        masks = {"per_order": 1, "period_budget": 2, "merchant": 4}
        mask = 0
        for reason in row["reasons"]:
            if reason not in masks:
                error("non_overridable_reason", 403)
            mask |= masks[reason]
        if row["snapshot_hash"] != row["current_snapshot_hash"] or proof["intentHash"] != info["intentHash"] or proof["riskDigest"] != row["envelope"]["risk"]["riskDigest"] or not mask or mask != proof["overrideMask"] or proof["validUntil"] > now + 120:
            error("approval_binding_mismatch")
        return row

    @app.post("/v1/approve-order")
    def approve_order_route(request: OrderApprovalRequest):
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        from .evm import order_consent_data
        with runtime.db.connection() as db, db.transaction():
            row = approval_target(db, request.approval_id)
            recovered = Account.recover_message(encode_typed_data(full_message=order_consent_data(runtime.gate, runtime.chain_id, row["address"], row["proof"])), signature=request.signature)
            if recovered.lower() != row["address"].lower():
                error("invalid_owner_signature", 401)
            if row["owner_signature"] and row["owner_signature"] != request.signature:
                error("approval_already_used", 409)
            db.execute("UPDATE approvals SET owner_signature=%s,authenticated_at=coalesce(authenticated_at,now()) WHERE id=%s", (request.signature, request.approval_id))
            db.execute("UPDATE intents SET state='authorized',updated_at=now() WHERE id=%s AND state='approval_required'", (row["intent_id"],))
            db.execute("UPDATE outbox SET available_at=now() WHERE dedupe_key=%s AND completed_at IS NULL", ("payment:" + str(row["intent_id"]),))
            audit(db, row["account_id"], "order.owner_approved", request.approval_id, {"intentId": str(row["intent_id"]), "overrideMask": row["proof"]["overrideMask"]})
            return {"intentId": str(row["intent_id"]), "status": "authorized"}

    @app.post("/v1/endorse-order")
    def endorse_order_route(request: ReceiptRequest):
        from .evm import human_data, order_consent_data
        from eth_utils import keccak
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        if not runtime.human:
            error("human_signer_unavailable", 503)
        with runtime.db.connection() as db, db.transaction():
            candidate = db.execute("SELECT id FROM approvals WHERE intent_id=%s AND owner_signature IS NOT NULL ORDER BY authenticated_at DESC LIMIT 1", (request.intent_id,)).fetchone()
            if not candidate:
                error("owner_proof_required", 403)
            row = approval_target(db, candidate["id"])
            now = int(time.time())
            if row["state"] != "authorized" or not row["authenticated_at"] or row["authenticated_at"].timestamp() < now - 120 or runtime.human.address.lower() != row["policy"]["chainPolicy"]["humanSigner"].lower():
                error("owner_proof_expired_or_wrong_signer", 403)
            proof = row["proof"]
            recovered = Account.recover_message(encode_typed_data(full_message=order_consent_data(runtime.gate, runtime.chain_id, row["address"], proof)), signature=row["owner_signature"])
            if recovered.lower() != row["address"].lower():
                error("invalid_owner_signature", 401)
            if "endorsement" in proof:
                return proof["endorsement"]
            human = {"approvalId": "0x" + keccak(text=str(row["id"])).hex(), "intentHash": proof["intentHash"], "riskDigest": proof["riskDigest"], "identityBindingId": row["policy"]["chainPolicy"]["identityBindingId"], "overrideMask": proof["overrideMask"], "authenticatedAt": int(row["authenticated_at"].timestamp()), "validUntil": proof["validUntil"]}
            endorsement = {"human": human, "signature": runtime.human.sign(human_data(runtime.gate, runtime.chain_id, human))}
            db.execute("UPDATE approvals SET used_at=now(),proof=%s WHERE id=%s", (Jsonb({**proof, "endorsement": endorsement}), row["id"]))
            audit(db, row["account_id"], "order.endorsed", row["id"], {"intentId": str(row["intent_id"])})
            return endorsement

    return app


def from_environment():
    from .crypto import KmsSigner, LocalSigner
    production = os.getenv("ENVIRONMENT") == "production"
    chain_id = int(os.getenv("CHAIN_ID", "80002"))
    if production and chain_id != 80002:
        raise RuntimeError("Only Polygon Amoy is enabled")

    def signer(env, kid):
        name = os.getenv(env)
        if name:
            return KmsSigner(name, kid)
        if production:
            raise RuntimeError(f"Missing {env}")
        return LocalSigner.load(os.getenv("LOCAL_KEY_DIR", ".local/keys") + "/" + kid + ".pem", kid)

    issuer, holder = signer("AP2_ISSUER_KEY", "ap2-issuer"), signer("AP2_AGENT_KEY", "ap2-agent")
    merchant = json.loads(os.environ["MERCHANT_PUBLIC_JWK"])
    pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=0, max_size=4, kwargs={"row_factory": dict_row})
    from .evm import KmsEvmSigner, LocalEvmSigner
    human = KmsEvmSigner(os.environ["HUMAN_KEY"]) if os.getenv("HUMAN_KEY") else None
    if not production and os.getenv("LOCAL_HUMAN_PRIVATE_KEY"):
        human = LocalEvmSigner(os.environ["LOCAL_HUMAN_PRIVATE_KEY"])
    return create_app(Runtime(pool, issuer, holder, merchant, chain_id, os.environ["GATE_ADDRESS"], os.environ["PUBLIC_ORIGIN"], human))
