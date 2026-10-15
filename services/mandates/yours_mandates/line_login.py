"""Fresh LINE Login proof for one immutable order; no password/session custody."""
import hashlib
import json
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from .line_consent import unseal, user_hash, verify_link


def verify_token(token: str, client_id: str, nonce: str, user_id: str) -> dict:
    request = Request('https://api.line.me/oauth2/v2.1/verify', data=urlencode({
        'id_token': token, 'client_id': client_id, 'nonce': nonce, 'user_id': user_id,
    }).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urlopen(request, timeout=8) as response:
        if response.geturl() != request.full_url:
            raise ValueError('line_verify_redirected')
        return json.loads(response.read(32768))


def validate_claims(claims: dict, client_id: str, nonce: str, user_id: str, started: int, now: int):
    if claims.get('iss') != 'https://access.line.me' or claims.get('aud') != client_id or claims.get('sub') != user_id or claims.get('nonce') != nonce:
        raise ValueError('line_identity_mismatch')
    if any(type(claims.get(k)) is not int for k in ('iat', 'exp', 'auth_time')):
        raise ValueError('line_fresh_auth_required')
    if claims['exp'] <= now or not started - 30 <= claims['iat'] <= now + 5 or not max(started - 30, now - 120) <= claims['auth_time'] <= now + 5:
        raise ValueError('line_auth_expired')
    # prompt=login and max_age=0 are requested. SSO/auto-login alone is not an
    # additional confirmation, even if an ID token was newly minted.
    amr = claims.get('amr')
    if not isinstance(amr, list) or not any(method in amr for method in ('pwd', 'lineqr', 'mfa')):
        raise ValueError('line_interactive_auth_required')


def verify_order_login(db, attempt_id, runtime, intent=None):
    attempt = db.execute('SELECT * FROM line_login_attempts WHERE id=%s', (attempt_id,)).fetchone()
    if not attempt or not attempt['intent_id'] or not attempt['token_cipher'] or not attempt['consented_at']:
        raise ValueError('line_order_consent_required')
    link = verify_link(db, attempt['link_id'], runtime)
    intent = intent or db.execute('SELECT * FROM intents WHERE id=%s', (attempt['intent_id'],)).fetchone()
    now = int(time.time())
    if not intent or intent['id'] != attempt['intent_id'] or intent['account_id'] != link['account_id'] or intent['connection_id'] != link['connection_id'] or intent['snapshot_hash'] != attempt['snapshot_hash'] or attempt['expires_at'].timestamp() <= now:
        raise ValueError('line_order_changed_or_expired')
    secrets = json.loads(unseal(runtime.chat_key, 'line-login:' + str(attempt['id']), attempt['secrets_cipher']))
    commitment = hashlib.sha256(('yours-line-order:' + str(intent['id']) + ':' + intent['snapshot_hash'] + ':' + secrets['salt']).encode()).hexdigest()
    if secrets['nonce'] != commitment:
        raise ValueError('line_order_nonce_mismatch')
    client_id = runtime.line_client_id
    if not client_id and runtime.line_bridge:
        with urlopen(runtime.line_bridge, timeout=8) as response:
            if response.geturl() != runtime.line_bridge:
                raise ValueError('line_bridge_redirected')
            info = json.loads(response.read(65536))
        if not info.get('loginConfigured'):
            raise ValueError('line_login_not_configured')
        client_id = info['loginChannelId']
    if not client_id or client_id != secrets['clientId']:
        raise ValueError('line_client_mismatch')
    token = unseal(runtime.chat_key, 'line-id-token:' + str(attempt['id']), attempt['token_cipher'])
    user_id = unseal(runtime.chat_key, 'line-user:' + str(link['id']), link['user_cipher'])
    if user_hash(user_id) != link['user_hash']:
        raise ValueError('line_user_changed')
    claims = verify_token(token, client_id, secrets['nonce'], user_id)
    validate_claims(claims, client_id, secrets['nonce'], user_id, int(attempt['created_at'].timestamp()), now)
    return attempt, link, claims
