"""Real AP2 v0.2 mandates and receipts, with deterministic task constraints."""
import json
import time
from dataclasses import dataclass
from ap2.sdk.mandate import MandateClient
from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.constraints import MandateContext
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.receipt_wrapper import ReceiptClient
from jwcrypto import jws
from jwcrypto.jwk import JWK
from .crypto import Signer, issue_open, present_closed, hash_b64, sign_jwt


@dataclass(frozen=True)
class Task:
    merchant_id: str
    merchant_name: str
    currency: str
    max_amount: int
    items: list[dict]
    instrument_id: str
    expires_at: int

    def validate(self, now: int):
        if self.currency not in ("JPY", "USD") or type(self.max_amount) is not int or not 0 < self.max_amount <= 9007199254740991:
            raise ValueError("Invalid ISO minor-unit budget")
        if not self.merchant_id or not self.merchant_name or not self.instrument_id or not now < self.expires_at <= now + 86400:
            raise ValueError("Invalid task scope or expiry")
        if not 1 <= len(self.items) <= 50:
            raise ValueError("A checkout task requires explicit candidate items")
        ids = set()
        for item in self.items:
            if set(item) != {"id", "title", "quantity"} or not item["id"] or not item["title"] or type(item["quantity"]) is not int or not 1 <= item["quantity"] <= 10000 or item["id"] in ids:
                raise ValueError("Invalid line-item requirement")
            ids.add(item["id"])


def issue(task: Task, holder_jwk: dict, issuer: Signer, now: int | None = None) -> dict:
    now = now or int(time.time())
    task.validate(now)
    if holder_jwk.get("kty") != "EC" or holder_jwk.get("crv") != "P-256" or any(k in holder_jwk for k in ("d", "k", "p", "q")):
        raise ValueError("Holder must supply only a public P-256 JWK")
    JWK(**holder_jwk)
    # The SDK's generated JsonWebKey currently serializes `use` as a Python
    # Enum rather than JSON. A minimal cnf JWK is standard compliant and avoids
    # that SDK serialization defect without changing its verifier.
    holder_jwk = {key: holder_jwk[key] for key in ("kty", "crv", "x", "y", "alg", "kid") if key in holder_jwk}
    merchant = {"id": task.merchant_id, "name": task.merchant_name}
    checkout = OpenCheckoutMandate.model_validate({
        "constraints": [
            {"type": "checkout.allowed_merchants", "allowed": [merchant]},
            {"type": "checkout.line_items", "items": [{"id": item["id"], "acceptable_items": [{"id": item["id"], "title": item["title"]}], "quantity": item["quantity"]} for item in task.items]},
        ], "cnf": {"jwk": holder_jwk}, "iat": now, "exp": task.expires_at,
    })
    open_checkout = issue_open(checkout.model_dump(exclude_none=True, mode="json"), issuer)
    payment = OpenPaymentMandate.model_validate({
        "constraints": [
            {"type": "payment.amount_range", "currency": task.currency, "min": 1, "max": task.max_amount},
            {"type": "payment.allowed_payees", "allowed": [merchant]},
            {"type": "payment.allowed_payment_instruments", "allowed": [{"id": task.instrument_id, "type": "stablecoin"}]},
            {"type": "payment.reference", "conditional_transaction_id": hash_b64(open_checkout.split("~")[0])},
            {"type": "payment.agent_recurrence", "frequency": "ON_DEMAND", "max_occurrences": 1},
            {"type": "payment.budget", "max": task.max_amount, "currency": task.currency},
        ], "cnf": {"jwk": holder_jwk}, "iat": now, "exp": task.expires_at,
    })
    return {"open_checkout": open_checkout, "open_payment": issue_open(payment.model_dump(exclude_none=True, mode="json"), issuer)}


def present(opens: dict, checkout_jwt: str, checkout: dict, holder: Signer, instrument_id: str, audience: str, nonce: str, now: int | None = None) -> dict:
    now = now or int(time.time())
    total = [row["amount"] for row in checkout["totals"] if row["type"] == "total"]
    if len(total) != 1 or checkout["status"] != "ready_for_complete":
        raise ValueError("Checkout is not ready")
    reference = hash_b64(checkout_jwt)
    closed_checkout = CheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=reference, iat=now, exp=now + 120)
    closed_payment = PaymentMandate.model_validate({
        "transaction_id": reference, "payee": checkout["merchant"],
        "payment_amount": {"currency": checkout["currency"], "amount": total[0]},
        "payment_instrument": {"id": instrument_id, "type": "stablecoin"},
        "iat": now, "exp": now + 120,
    })
    return {
        "checkout_mandate": present_closed(opens["open_checkout"], closed_checkout.model_dump(exclude_none=True, mode="json"), holder, audience, nonce, now),
        "payment_mandate": present_closed(opens["open_payment"], closed_payment.model_dump(exclude_none=True, mode="json"), holder, audience, nonce, now),
    }


def verify(mandates: dict, checkout_jwt: str, issuer_jwk: dict, merchant_jwk: dict, audience: str, nonce: str, instrument_id: str, usage: dict | None = None) -> dict:
    client = MandateClient()
    # The caller resolves both public keys from enrolled profiles, never token jku/jwk.
    merchant_token = jws.JWS()
    merchant_token.deserialize(checkout_jwt)
    if merchant_token.jose_header.get("alg") != "ES256" or merchant_token.jose_header.get("kid") != merchant_jwk.get("kid"):
        raise ValueError("Merchant key mismatch")
    merchant_token.verify(JWK(**merchant_jwk), alg="ES256")
    checkout = json.loads(merchant_token.payload)
    if checkout.get("status") != "ready_for_complete":
        raise ValueError("Checkout is not ready")
    payloads = {}
    for kind in ("checkout", "payment"):
        value = mandates[kind + "_mandate"]
        if not isinstance(value, str) or len(value) > 65536 or value.count("~~") != 1:
            raise ValueError("Exactly one AP2 delegation hop is supported")
        resolved = client.verify(value, lambda _token: JWK(**issuer_jwk), expected_aud=audience, expected_nonce=nonce, clock_skew_seconds=30)
        if not isinstance(resolved, list) or len(resolved) != 2:
            raise ValueError("Open-to-closed mandate chain required")
        for claim in resolved:
            now = int(time.time())
            if type(claim.get("iat")) is not int or type(claim.get("exp")) is not int or claim["iat"] > now + 30 or claim["exp"] <= now:
                raise ValueError("Invalid mandate lifetime")
        payloads[kind] = resolved
    cm = CheckoutMandateChain.parse(payloads["checkout"])
    pm = PaymentMandateChain.parse(payloads["payment"])
    reference = hash_b64(checkout_jwt)
    violations = cm.verify(expected_checkout_hash=reference, checkout_jwt=checkout_jwt)
    open_checkout_hash = hash_b64(mandates["checkout_mandate"].split("~")[0])
    violations += pm.verify(expected_transaction_id=reference, expected_open_checkout_hash=open_checkout_hash, mandate_context=MandateContext(**(usage or {})))
    if cm.closed_mandate.checkout_jwt != checkout_jwt:
        violations.append("Checkout JWT mismatch")
    total = [row["amount"] for row in checkout["totals"] if row["type"] == "total"]
    if len(total) != 1 or pm.closed_mandate.payment_amount.amount != total[0] or pm.closed_mandate.payment_amount.currency != checkout["currency"]:
        violations.append("Payment does not match checkout total")
    if pm.closed_mandate.payee.id != checkout.get("merchant", {}).get("id") or pm.closed_mandate.payment_instrument.id != instrument_id or pm.closed_mandate.payment_instrument.type != "stablecoin":
        violations.append("Payment recipient or instrument mismatch")
    if payloads["checkout"][0]["cnf"] != payloads["payment"][0]["cnf"]:
        violations.append("Different mandate holders")
    if violations:
        raise ValueError("; ".join(violations))
    return {
        "checkout_reference": hash_b64(client.get_closed_mandate_jwt(mandates["checkout_mandate"])),
        "payment_reference": hash_b64(client.get_closed_mandate_jwt(mandates["payment_mandate"])),
        "transaction_id": reference,
        "payment": pm.closed_mandate.model_dump(exclude_none=True, mode="json"),
    }


def receipts(verified: dict, order_id: str, transaction_hash: str, issuer: str, signer: Signer) -> dict:
    if len(transaction_hash) != 66 or not transaction_hash.startswith("0x"):
        raise ValueError("A confirmed settlement transaction hash is required")
    client = ReceiptClient()
    payment = PaymentMandate.model_validate(verified["payment"])
    pr = client.create_payment_receipt(payment, verified["payment_reference"])
    pr = type(pr).model_validate({**pr.model_dump(mode="json"), "iss": issuer, "payment_id": verified["transaction_id"], "psp_confirmation_id": order_id, "network_confirmation_id": transaction_hash})
    cr = client.create_checkout_receipt(issuer, verified["checkout_reference"], order_id)
    return {"payment_receipt": sign_jwt(pr.model_dump(exclude_none=True, mode="json"), signer, "JWT"),
            "checkout_receipt": sign_jwt(cr.model_dump(exclude_none=True, mode="json"), signer, "JWT")}
