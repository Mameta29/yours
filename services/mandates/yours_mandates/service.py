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
            if not row or row["state"] != "authorized" or row["status"] != "active" or row["revoked_at"] or min(row["expires_at"].timestamp(), row["mandate_expires"].timestamp()) <= time.time():
                error("execution_not_authorized", 403)
            snapshot = row["snapshot"]
            tokens = snapshot["mandates"]
            for kind in ("checkout", "payment"):
                if tokens.get(kind + "_mandate", "").split("~~")[0].rstrip("~") != row["open_" + kind].rstrip("~"):
                    error("mandate_authority_mismatch")
            checkout = snapshot["checkout"]
            return verify(tokens, snapshot["checkoutJwt"], runtime.issuer.public_jwk(), runtime.merchant_jwk, checkout["yours"]["audience"], checkout["yours"]["nonce"], snapshot["instrumentId"], {"total_uses": 0, "total_amount": 0})

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
    return create_app(Runtime(pool, issuer, holder, merchant, chain_id, os.environ["GATE_ADDRESS"], os.environ["PUBLIC_ORIGIN"]))
