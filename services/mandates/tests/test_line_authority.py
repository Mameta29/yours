import base64
import hashlib
import hmac
import json
import os
import time
import uuid
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb
from yours_mandates.crypto import LocalSigner
from yours_mandates.line_consent import LINE_SCOPE, line_consent_data, user_hash, verify_link
from yours_mandates.line_login import validate_claims
from yours_mandates.service import Runtime, create_app
from test_service import setup, GATE


def seal(key, purpose, text):
    iv = os.urandom(12)
    encrypted = AESGCM(base64.b64decode(key)).encrypt(iv, text.encode(), purpose.encode())
    enc = lambda x: base64.urlsafe_b64encode(x).decode().rstrip('=')
    return '.'.join(['v1', enc(iv), enc(encrypted[:-16]), enc(encrypted[-16:])])


@pytest.fixture
def line(setup):
    s = setup
    key = base64.b64encode(os.urandom(32)).decode()
    runtime = Runtime(s['pool'], LocalSigner('line-issuer'), LocalSigner('line-holder'), s['merchant'].public_jwk(), 80002, GATE, 'https://merchant.example', chat_key=key, line_secret='line-fixture-secret')
    link_id, event_id, policy_id = uuid.uuid4(), uuid.uuid4(), '0x' + 'ab' * 32
    user, now, email = 'U' + 'a' * 32, int(time.time()), 'owner@example.test'
    consent = {'account': s['wallet'].address.lower(), 'connectionId': str(s['connection']), 'lineUserHash': user_hash(user),
        'policyId': policy_id, 'emailHash': hashlib.sha256(email.encode()).hexdigest(), 'scope': LINE_SCOPE,
        'nonce': '0x' + os.urandom(32).hex(), 'validUntil': now + 3500}
    sig = '0x' + Account.sign_message(encode_typed_data(full_message=line_consent_data(consent, 80002, GATE)), s['wallet'].key).signature.hex()
    raw = json.dumps({'events': [{'webhookEventId': 'fixture-' + str(event_id), 'timestamp': now * 1000, 'type': 'message',
        'source': {'type': 'user', 'userId': user}, 'message': {'type': 'text', 'text': 'お茶をひとつ買って'}}]})
    body_hash = hashlib.sha256(raw.encode()).hexdigest()
    line_sig = base64.b64encode(hmac.new(runtime.line_secret.encode(), raw.encode(), hashlib.sha256).digest()).decode()
    decision = {'action': 'purchase', 'productId': 'tea', 'merchantId': 'test-merchant', 'quantity': 1, 'amount': 1000}
    with s['pool'].connection() as db:
        db.execute('UPDATE policies SET policy_id=%s WHERE account_id=%s', (policy_id, s['owner']))
        db.execute('''INSERT INTO line_links(id,account_id,connection_id,code_hash,code_expires_at,user_hash,user_cipher,email_cipher,consent,owner_signature,expires_at,activated_at)
            VALUES(%s,%s,%s,%s,now()+interval '5 minutes',%s,%s,%s,%s,%s,to_timestamp(%s),to_timestamp(%s))''',
            (link_id, s['owner'], s['connection'], str(uuid.uuid4()), user_hash(user), seal(key, 'line-user:' + str(link_id), user), seal(key, 'line-email:' + str(link_id), email), Jsonb(consent), sig, now + 3500, now - 1))
        db.execute('INSERT INTO line_inbox(body_hash,body_cipher,signature) VALUES(%s,%s,%s)', (body_hash, seal(key, 'line-body:' + body_hash, raw), line_sig))
        db.execute('INSERT INTO line_events(id,event_id,body_hash,link_id,decision,consent_id) VALUES(%s,%s,%s,%s,%s,%s)',
            (event_id, 'fixture-' + str(event_id), body_hash, link_id, Jsonb(decision), s['consent']))
        db.execute('UPDATE task_consents SET line_event_id=%s WHERE id=%s', (event_id, s['consent']))
    s.update(runtime=runtime, client=TestClient(create_app(runtime)), link_id=link_id, event_id=event_id, body_hash=body_hash, key=key, consent_data=consent)
    yield s
    # Each fixture uses a distinct wallet; release the shared fixture LINE ID.
    with s['pool'].connection() as db:
        db.execute('UPDATE line_links SET revoked_at=now() WHERE id=%s', (link_id,))


def issue_line(s):
    return s['client'].post('/v1/issue', json={'consent_id': str(s['consent']), 'line_event_id': str(s['event_id'])})


def test_standing_wallet_authority_issues_exact_task_once_without_fabricating_an_order_signature(line):
    response = issue_line(line)
    assert response.status_code == 200, response.text
    assert issue_line(line).json() == response.json()
    with line['pool'].connection() as db:
        consent = db.execute('SELECT * FROM task_consents WHERE id=%s', (line['consent'],)).fetchone()
        assert consent['owner_signature'] is None
        assert consent['consumed_at'] is not None
        assert db.execute('SELECT count(*) AS n FROM mandates WHERE consent_id=%s', (line['consent'],)).fetchone()['n'] == 1


@pytest.mark.parametrize('mutation', ['wallet', 'webhook', 'selection', 'sender', 'scope', 'expired', 'revoked'])
def test_channel_or_model_data_cannot_bypass_the_wallet_authority(line, mutation):
    with line['pool'].connection() as db:
        if mutation == 'wallet':
            wrong = '0x' + Account.sign_message(encode_typed_data(full_message=line_consent_data(line['consent_data'], 80002, GATE)), Account.create().key).signature.hex()
            db.execute('UPDATE line_links SET owner_signature=%s WHERE id=%s', (wrong, line['link_id']))
        elif mutation == 'webhook':
            db.execute("UPDATE line_inbox SET signature='invalid' WHERE body_hash=%s", (line['body_hash'],))
        elif mutation == 'selection':
            db.execute("UPDATE line_events SET decision=jsonb_set(decision,'{quantity}','2') WHERE id=%s", (line['event_id'],))
        elif mutation == 'sender':
            db.execute("UPDATE line_links SET user_hash=%s WHERE id=%s", (user_hash('U' + 'b' * 32), line['link_id']))
        elif mutation == 'scope':
            db.execute("UPDATE line_links SET consent=jsonb_set(consent,'{scope}','\"any transfer\"') WHERE id=%s", (line['link_id'],))
        elif mutation == 'expired':
            db.execute("UPDATE line_links SET expires_at=now()-interval '1 second' WHERE id=%s", (line['link_id'],))
        else:
            db.execute('UPDATE line_links SET revoked_at=now() WHERE id=%s', (line['link_id'],))
    assert issue_line(line).status_code == 422


def test_a_channel_event_cannot_be_attached_to_another_task(line):
    response = line['client'].post('/v1/issue', json={'consent_id': str(line['consent']), 'line_event_id': str(uuid.uuid4())})
    assert response.status_code == 422
    response = line['client'].post('/v1/issue', json={'consent_id': str(line['consent']), 'signature': line['signature']})
    assert response.status_code == 403


@pytest.mark.parametrize('claim', ['nonce', 'sub', 'aud', 'iss', 'auth_time', 'exp', 'amr'])
def test_line_exception_requires_fresh_interactive_login_to_the_bound_account(claim):
    now = 1800000000
    claims = {'iss': 'https://access.line.me', 'aud': 'client', 'sub': 'user', 'nonce': 'order-nonce', 'iat': now, 'exp': now + 300, 'auth_time': now, 'amr': ['lineqr']}
    validate_claims(claims, 'client', 'order-nonce', 'user', now - 20, now)
    changed = {**claims, claim: {'auth_time': now - 121, 'exp': now - 1, 'amr': ['lineautologin', 'linesso']}.get(claim, 'wrong')}
    with pytest.raises(ValueError):
        validate_claims(changed, 'client', 'order-nonce', 'user', now - 20, now)
