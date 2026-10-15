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
from .line_consent import verify_event

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
    chat_key: str | None = None
    line_secret: str | None = None
    line_client_id: str | None = None
    ec_merchants: Any = None
    line_bridge: str | None = None


class IssueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_id: uuid.UUID
    signature: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{130}$")
    line_event_id: uuid.UUID | None = None


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


class LineApprovalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    attempt_id: uuid.UUID


def error(code: str, status=422):
    raise HTTPException(status_code=status, detail=code)


def audit(db, account, action, resource, data=None):
    db.execute("INSERT INTO audit_events(account_id,actor,action,resource_id,data) VALUES(%s,'mandates-service',%s,%s,%s)",
               (account, action, str(resource), Jsonb(data or {})))


def load_checkout(db, request: CheckoutRequest, runtime=None):
    mandate = db.execute("SELECT m.*,c.status,c.provider,c.ap2_public_jwk FROM mandates m JOIN connections c ON c.id=m.connection_id WHERE m.id=%s", (request.mandate_id,)).fetchone()
    if not mandate or mandate["revoked_at"] or mandate["expires_at"].timestamp() <= time.time() or mandate["status"] != "active":
        error("mandate_inactive", 403)
    verify_line_mandate(db, mandate, runtime)
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
    verify_ec_binding(db, mandate["task"], checkout["document"], mandate["account_id"], mandate["connection_id"])
    usage = db.execute("SELECT count(*)::int AS total_uses,coalesce(sum(amount_minor),0)::bigint AS total_amount FROM mandate_consumptions WHERE mandate_id=%s", (request.mandate_id,)).fetchone()
    return mandate, checkout["document"], usage


def verify_line_mandate(db, mandate, runtime):
    if not mandate.get('consent_id'):
        return
    consent = db.execute('SELECT * FROM task_consents WHERE id=%s', (mandate['consent_id'],)).fetchone()
    if consent and consent['line_event_id']:
        verify_event(db, consent['line_event_id'], consent, runtime)


def verify_ec_binding(db, task, checkout, account_id, connection_id):
    """The legacy owner's reservation proof is separate from AP2 consent."""
    reserved = task.get("checkout_id")
    external = checkout.get("yours", {}).get("ec")
    if not reserved and not external:
        return
    if not reserved or reserved != checkout["id"] or not external:
        error("ec_checkout_mismatch")
    row = db.execute("SELECT * FROM ec_reservations WHERE checkout_id=%s AND account_id=%s AND connection_id=%s", (reserved, account_id, connection_id)).fetchone()
    if not row or not row["authorized_at"] or row["quote"]["expiresAt"] <= time.time() * 1000:
        error("ec_owner_authorization_required", 403)
    quote = row["quote"]
    if task.get("requirements_hash") != quote["requirementsHash"] or external.get("reservation_id") != quote["reservationId"] or external.get("requirements_hash") != quote["requirementsHash"] or checkout["merchant"]["id"] != row["merchant_id"] or checkout["yours"]["pay_to"].lower() != quote["accepted"]["payTo"].lower() or task["max_amount"] != quote["amountMinor"]:
        error("ec_reservation_binding_mismatch")


def create_app(runtime: Runtime):
    app = FastAPI(title="yours private mandate authority", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ValueError)
    async def bad_value(_request, _error):
        # Do not return upstream crypto exception messages or token payloads.
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=422, content={"detail": "mandate_or_consent_invalid"})

    @app.get("/health")
    def health():
        return {"ok": True, "service": "yours-mandates"}

    @app.get("/v1/keys")
    def keys():
        return {"issuer": runtime.issuer.public_jwk(), "holder": runtime.holder.public_jwk()}

    @app.post("/v1/ec-delegation")
    def ec_delegation(request: IssueRequest):
        from .crypto import sign_jwt
        import hashlib
        if request.signature or not request.line_event_id:
            error("line_authority_required", 403)
        with runtime.db.connection() as db, db.transaction():
            row = db.execute("SELECT * FROM task_consents WHERE id=%s", (request.consent_id,)).fetchone()
            if not row:
                error("consent_not_found", 404)
            db.execute("SELECT id FROM accounts WHERE id=%s FOR UPDATE", (row["account_id"],))
            link, event = verify_event(db, request.line_event_id, row, runtime)
            reservation = db.execute("SELECT * FROM ec_reservations WHERE consent_id=%s", (row['id'],)).fetchone()
            merchant = next((m for m in runtime.ec_merchants or [] if reservation and m['id'] == reservation['merchant_id']), None)
            if not reservation or not merchant or reservation['account_id'] != row['account_id'] or reservation['connection_id'] != row['connection_id']:
                error("ec_reservation_mismatch")
            quote, task = reservation['quote'], row['task']
            now = int(time.time())
            if quote['expiresAt'] <= (now + 30) * 1000 or task['checkout_id'] != str(reservation['checkout_id']) or task['max_amount'] != quote['amountMinor'] or task['requirements_hash'] != quote['requirementsHash']:
                error("ec_quote_changed")
            if quote['accepted']['payTo'].lower() != merchant['payTo'].lower() or quote['accepted']['network'] != 'eip155:' + str(runtime.chain_id):
                error("ec_payment_binding_mismatch")
            payload = {'iss': runtime.origin, 'aud': merchant['origin'] + '/api/v1/checkout/authorize-transfer',
                'sub': link['address'], 'iat': now, 'exp': min(now + 120, task['expires_at'], quote['expiresAt'] // 1000),
                'jti': str(event['id']), 'reservation_id': quote['reservationId'],
                'message_sha256': hashlib.sha256(quote['message'].encode()).hexdigest(),
                'chain_id': runtime.chain_id, 'gate': runtime.gate, 'consent': link['consent'], 'owner_signature': link['owner_signature']}
            return {'proof': sign_jwt(payload, runtime.issuer, 'yours-ec-delegation+jwt')}

    @app.post("/v1/issue")
    def issue_route(request: IssueRequest):
        if bool(request.signature) == bool(request.line_event_id):
            error("exactly_one_consent_required")
        with runtime.db.connection() as db, db.transaction():
            target = db.execute("SELECT account_id FROM task_consents WHERE id=%s", (request.consent_id,)).fetchone()
            if not target:
                error("consent_not_found", 404)
            db.execute("SELECT id FROM accounts WHERE id=%s FOR UPDATE", (target["account_id"],))
            row = db.execute("SELECT s.*,a.address,c.status,c.provider,c.ap2_public_jwk FROM task_consents s JOIN accounts a ON a.id=s.account_id JOIN connections c ON c.id=s.connection_id WHERE s.id=%s FOR UPDATE OF s", (request.consent_id,)).fetchone()
            if row["consumed_at"]:
                if row["owner_signature"] != request.signature or row['line_event_id'] != request.line_event_id:
                    error("consent_already_used", 409)
                old = db.execute("SELECT id,open_checkout,open_payment FROM mandates WHERE consent_id=%s", (request.consent_id,)).fetchone()
                return {**old, "id": str(old["id"])}
            if row["status"] != "active":
                error("permission_inactive", 403)
            if request.line_event_id:
                verify_event(db, request.line_event_id, row, runtime)
            else:
                if row['line_event_id']:
                    error('line_consent_cannot_change_kind', 403)
                verify_consent(row, request.signature, runtime.chain_id, runtime.gate, int(time.time()))
            task = Task(**row["task"])
            if task.checkout_id:
                reserved = db.execute("SELECT document FROM merchant_sessions WHERE id=%s", (task.checkout_id,)).fetchone()
                if not reserved:
                    error("ec_checkout_not_found", 404)
                verify_ec_binding(db, row["task"], reserved["document"], row["account_id"], row["connection_id"])
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
            mandate, checkout, usage = load_checkout(db, request, runtime)
            if mandate["provider"] != "gemini":
                error("external_agent_must_sign_its_own_presentation", 403)
            tokens = present(mandate, request.checkout_jwt, checkout, runtime.holder, mandate["task"]["instrument_id"], checkout["yours"]["audience"], checkout["yours"]["nonce"], expires_at=int(mandate["expires_at"].timestamp()))
            # An authenticated caller still cannot ask the holder to accept an
            # altered/out-of-scope merchant checkout. Verify before returning.
            verify(tokens, request.checkout_jwt, runtime.issuer.public_jwk(), runtime.merchant_jwk, checkout["yours"]["audience"], checkout["yours"]["nonce"], mandate["task"]["instrument_id"], usage)
            return tokens

    @app.post("/v1/verify")
    def verify_route(request: VerifyRequest):
        with runtime.db.connection() as db:
            mandate, checkout, usage = load_checkout(db, request, runtime)
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
            row = db.execute("SELECT i.*,m.task,m.consent_id,m.open_checkout,m.open_payment,m.revoked_at,m.expires_at AS mandate_expires,c.status FROM intents i JOIN mandate_consumptions mc ON mc.intent_id=i.id JOIN mandates m ON m.id=mc.mandate_id JOIN connections c ON c.id=i.connection_id WHERE i.id=%s", (request.intent_id,)).fetchone()
            if not row or row["state"] not in ("authorized", "approval_required") or row["status"] != "active" or row["revoked_at"] or min(row["expires_at"].timestamp(), row["mandate_expires"].timestamp()) <= time.time():
                error("execution_not_authorized", 403)
            verify_line_mandate(db, row, runtime)
            snapshot = row["snapshot"]
            tokens = snapshot["mandates"]
            for kind in ("checkout", "payment"):
                if tokens.get(kind + "_mandate", "").split("~~")[0].rstrip("~") != row["open_" + kind].rstrip("~"):
                    error("mandate_authority_mismatch")
            checkout = snapshot["checkout"]
            verify_ec_binding(db, row["task"], checkout, row["account_id"], row["connection_id"])
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

    @app.post('/v1/approve-line-order')
    def approve_line_order(request: LineApprovalRequest):
        from .line_login import verify_order_login
        from .line_consent import user_hash
        with runtime.db.connection() as db, db.transaction():
            target = db.execute('SELECT account_id FROM line_login_attempts WHERE id=%s', (request.attempt_id,)).fetchone()
            if not target:
                error('line_login_not_found', 404)
            db.execute('SELECT id FROM accounts WHERE id=%s FOR UPDATE', (target['account_id'],))
            attempt, link, claims = verify_order_login(db, request.attempt_id, runtime)
            intent = db.execute('SELECT i.*,e.payload,e.envelope FROM intents i JOIN payment_envelopes e ON e.intent_id=i.id WHERE i.id=%s FOR UPDATE OF i', (attempt['intent_id'],)).fetchone()
            previous = db.execute('SELECT * FROM approvals WHERE line_login_attempt_id=%s', (request.attempt_id,)).fetchone()
            if previous:
                approval_target(db, previous['id'])
                return {'intentId': str(intent['id']), 'status': intent['state']}
            if attempt['consumed_at'] or not intent or intent['state'] != 'approval_required':
                error('line_order_not_approvable', 409)
            now, mask = int(time.time()), 0
            for reason in intent['reasons']:
                if reason not in ('per_order', 'period_budget', 'merchant'):
                    error('non_overridable_reason', 403)
                mask |= {'per_order': 1, 'period_budget': 2, 'merchant': 4}[reason]
            valid_until = min(now + 90, claims['auth_time'] + 120, int(intent['expires_at'].timestamp()), link['consent']['validUntil'])
            if not mask or valid_until <= now + 15:
                error('line_order_expiring', 409)
            approval_id = uuid.uuid4()
            proof = {'nonce': '0x' + os.urandom(32).hex(), 'validUntil': valid_until, 'overrideMask': mask,
                'intentHash': intent['payload']['extensions']['yours.purchase']['info']['intentHash'], 'riskDigest': intent['envelope']['risk']['riskDigest']}
            db.execute('INSERT INTO approvals(id,intent_id,snapshot_hash,proof,expires_at,authenticated_at,line_login_attempt_id) VALUES(%s,%s,%s,%s,to_timestamp(%s),to_timestamp(%s),%s)',
                (approval_id, intent['id'], intent['snapshot_hash'], Jsonb(proof), valid_until, claims['auth_time'], request.attempt_id))
            approval_target(db, approval_id)
            db.execute('UPDATE line_login_attempts SET consumed_at=now(),subject_hash=%s,authenticated_at=to_timestamp(%s) WHERE id=%s', (user_hash(claims['sub']), claims['auth_time'], request.attempt_id))
            db.execute("UPDATE intents SET state='authorized',updated_at=now() WHERE id=%s", (intent['id'],))
            db.execute("UPDATE outbox SET available_at=now() WHERE dedupe_key=%s AND completed_at IS NULL", ('payment:' + str(intent['id']),))
            audit(db, link['account_id'], 'order.line_approved', approval_id, {'intentId': str(intent['id']), 'overrideMask': mask, 'authentication': 'LINE Login'})
            return {'intentId': str(intent['id']), 'status': 'authorized'}

    @app.post("/v1/endorse-order")
    def endorse_order_route(request: ReceiptRequest):
        from .evm import human_data, order_consent_data
        from eth_utils import keccak
        from eth_account import Account
        from eth_account.messages import encode_typed_data
        if not runtime.human:
            error("human_signer_unavailable", 503)
        with runtime.db.connection() as db, db.transaction():
            candidate = db.execute("SELECT id FROM approvals WHERE intent_id=%s AND (owner_signature IS NOT NULL OR line_login_attempt_id IS NOT NULL) ORDER BY authenticated_at DESC LIMIT 1", (request.intent_id,)).fetchone()
            if not candidate:
                error("owner_proof_required", 403)
            row = approval_target(db, candidate["id"])
            now = int(time.time())
            if row["state"] != "authorized" or not row["authenticated_at"] or row["authenticated_at"].timestamp() < now - 120 or runtime.human.address.lower() != row["policy"]["chainPolicy"]["humanSigner"].lower():
                error("owner_proof_expired_or_wrong_signer", 403)
            proof = row["proof"]
            if row['line_login_attempt_id']:
                from .line_login import verify_order_login
                attempt, link, claims = verify_order_login(db, row['line_login_attempt_id'], runtime)
                if attempt['intent_id'] != row['intent_id'] or not attempt['consumed_at'] or claims['auth_time'] != int(row['authenticated_at'].timestamp()):
                    error('line_approval_binding_mismatch', 403)
            else:
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
    return create_app(Runtime(pool, issuer, holder, merchant, chain_id, os.environ["GATE_ADDRESS"], os.environ["PUBLIC_ORIGIN"], human,
        os.getenv('CHAT_ENCRYPTION_KEY'), os.getenv('LINE_CHANNEL_SECRET'), os.getenv('LINE_LOGIN_CHANNEL_ID'), json.loads(os.getenv('EC_MERCHANTS_JSON', '[]')), os.getenv('LINE_BRIDGE_URL')))
