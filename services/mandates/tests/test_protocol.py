import copy
import json
import time
import pytest
from jwcrypto.jwk import JWK
from ap2.sdk.mandate import MandateClient
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.receipt_wrapper import ReceiptClient
from yours_mandates.crypto import LocalSigner, sign_jwt, hash_b64, present_closed
from yours_mandates.protocol import Task, issue, present, verify, receipts

@pytest.fixture
def flow():
    issuer, holder, merchant = LocalSigner("issuer"), LocalSigner("agent"), LocalSigner("merchant")
    now = int(time.time())
    task = Task("tea", "Tea store", "JPY", 1500, [{"id": "tea-1", "title": "Tea", "quantity": 2}], "wallet-1", now + 3600)
    opens = issue(task, holder.public_jwk(), issuer)
    checkout = {"id": "checkout-1", "merchant": {"id": "tea", "name": "Tea store"}, "ucp": {"version": "2026-08-25", "payment_handlers": {}},
                "line_items": [{"id": "line-1", "item": {"id": "tea-1", "title": "Tea", "price": 500}, "quantity": 2, "totals": [{"type": "total", "amount": 1000}]}],
                "currency": "JPY", "status": "ready_for_complete", "totals": [{"type": "subtotal", "amount": 1000}, {"type": "total", "amount": 1000}], "links": []}
    jwt = sign_jwt(checkout, merchant, "JWT")
    mandates = present(opens, jwt, checkout, holder, "wallet-1", "https://merchant.example", "nonce-1")
    args = [mandates, jwt, issuer.public_jwk(), merchant.public_jwk(), "https://merchant.example", "nonce-1", "wallet-1"]
    return issuer, holder, merchant, opens, checkout, args

def test_kms_compatible_signatures_verify_with_official_sdk(flow):
    *_, args = flow
    result = verify(*args)
    assert result["transaction_id"] == hash_b64(args[1])

def test_official_sdk_presentation_is_accepted(flow):
    issuer, holder, merchant, opens, checkout, args = flow
    client = MandateClient()
    key = JWK.from_pyca(holder.key)
    now = int(time.time())
    cm = CheckoutMandate(checkout_jwt=args[1], checkout_hash=hash_b64(args[1]), iat=now, exp=now+120)
    pm = PaymentMandate(transaction_id=hash_b64(args[1]), payee=checkout["merchant"], payment_amount={"amount":1000,"currency":"JPY"}, payment_instrument={"id":"wallet-1","type":"stablecoin"}, iat=now, exp=now+120)
    args[0] = {"checkout_mandate":client.present(key, opens["open_checkout"], [cm], nonce="nonce-1", aud=args[4]),
               "payment_mandate":client.present(key, opens["open_payment"], [pm], nonce="nonce-1", aud=args[4])}
    assert verify(*args)["payment_reference"]

@pytest.mark.parametrize("position,value", [(4,"https://evil.example"),(5,"wrong-nonce"),(6,"other-wallet")])
def test_verifier_binding_cannot_be_replayed(flow, position, value):
    *_, args = flow
    args[position] = value
    with pytest.raises(ValueError):
        verify(*args)

@pytest.mark.parametrize("change", ["amount","merchant","items"])
def test_signed_but_out_of_scope_checkout_is_rejected(flow, change):
    issuer, holder, merchant, opens, checkout, args = flow
    if change == "amount": checkout["totals"][-1]["amount"] = 2000
    if change == "merchant": checkout["merchant"]["id"] = "evil"
    if change == "items": checkout["line_items"][0]["item"]["id"] = "other-item"
    args[1] = sign_jwt(checkout, merchant, "JWT")
    args[0] = present(opens,args[1],checkout,holder,"wallet-1",args[4],args[5])
    with pytest.raises(ValueError):
        verify(*args)

def test_receipts_reference_closed_mandates_and_actual_transaction(flow):
    issuer, holder, merchant, opens, checkout, args = flow
    verified = verify(*args)
    tx = "0x" + "ab"*32
    signed = receipts(verified,"order-1",tx,"https://merchant.example",merchant)
    receipt = ReceiptClient().verify_receipt(signed["payment_receipt"], JWK(**merchant.public_jwk()), lambda ref: ref == verified["payment_reference"])
    assert receipt.get("verified") is True, receipt

def test_private_holder_keys_and_unscoped_tasks_are_rejected(flow):
    issuer, holder, *_ = flow
    task = Task("tea","Tea store","JPY",1000,[],"wallet-1",int(time.time())+300)
    with pytest.raises(ValueError):issue(task,holder.public_jwk(),issuer)
    task.items.append({"id":"tea","title":"Tea","quantity":1})
    with pytest.raises(ValueError):issue(task,{**holder.public_jwk(),"d":"private"},issuer)

def test_one_task_cannot_be_spent_twice(flow):
    *_, args = flow
    with pytest.raises(ValueError, match="occurrence|recurrence|limit|maximum"):
        verify(*args, usage={"total_uses": 1, "total_amount": 1000})
