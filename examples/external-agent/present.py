"""External-holder AP2 v0.2 presentation with the pinned official SDK.

Run in the services/mandates uv environment. Read one JSON request from stdin;
private_jwk belongs to this external client and is never sent to yours. Only
the signed mandates are written to stdout. The caller must verify checkoutJwt
against the enrolled merchant key before passing its approved checkout here.
"""
import base64
import hashlib
import json
import sys
import time
from jwcrypto.jwk import JWK
from ap2.sdk.mandate import MandateClient
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate

request = json.load(sys.stdin)
key = JWK(**request.pop('private_jwk'))
checkout = request['checkout']
reference = base64.urlsafe_b64encode(hashlib.sha256(request['checkoutJwt'].encode()).digest()).decode().rstrip('=')
now = int(time.time())
expiry = min(now + 600, request['expiresAt'])
if expiry <= now or checkout['status'] != 'ready_for_complete':
    raise ValueError('checkout_not_ready')
total, = [row['amount'] for row in checkout['totals'] if row['type'] == 'total']
closed_checkout = CheckoutMandate(checkout_jwt=request['checkoutJwt'], checkout_hash=reference, iat=now, exp=expiry)
closed_payment = PaymentMandate(transaction_id=reference, payee=checkout['merchant'],
    payment_amount={'amount': total, 'currency': checkout['currency']},
    payment_instrument={'id': request['instrumentId'], 'type': 'stablecoin'}, iat=now, exp=expiry)
client = MandateClient()
print(json.dumps({
    'checkout_mandate': client.present(key, request['open_checkout'], [closed_checkout], nonce=checkout['yours']['nonce'], aud=checkout['yours']['audience']),
    'payment_mandate': client.present(key, request['open_payment'], [closed_payment], nonce=checkout['yours']['nonce'], aud=checkout['yours']['audience']),
}))
