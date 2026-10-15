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


def order_action(s, action='approve', mutation=None):
    intent_id, action_id = uuid.uuid4(), uuid.uuid4()
    token = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    snapshot_hash = 'ab' * 32
    now = int(time.time())
    postback = {'webhookEventId': 'action-' + str(action_id), 'timestamp': now * 1000,
        'type': 'postback', 'source': {'type': 'user', 'userId': 'U' + 'a' * 32}, 'postback': {'data': 'yours:' + action + ':' + token}}
    if mutation == 'sender': postback['source']['userId'] = 'U' + 'b' * 32
    if mutation == 'token': postback['postback']['data'] += 'wrong'
    if mutation == 'stale': postback['timestamp'] -= 121000
    if mutation == 'chat': postback['type'] = 'message'
    raw = json.dumps({'events': [postback]})
    body_hash = hashlib.sha256(raw.encode()).hexdigest()
    signature = base64.b64encode(hmac.new(s['runtime'].line_secret.encode(), raw.encode(), hashlib.sha256).digest()).decode()
    with s['pool'].connection() as db:
        db.execute('''INSERT INTO intents(id,account_id,connection_id,merchant_id,checkout_id,revision,currency,amount_minor,amount_atomic,period_index,state,snapshot,snapshot_hash,reasons,expires_at)
            VALUES(%s,%s,%s,'test',%s,'1','JPY',1000,1000000000000000000000,0,'approval_required','{}',%s,%s,now()+interval '10 minutes')''',
            (intent_id, s['owner'], s['connection'], str(intent_id), snapshot_hash, Jsonb(['expired'] if mutation == 'reason' else ['per_order', 'merchant'])))
        db.execute('UPDATE line_events SET intent_id=%s WHERE id=%s', (intent_id, s['event_id']))
        db.execute('INSERT INTO line_approval_links(token_hash,token_cipher,event_id,intent_id,snapshot_hash,expires_at) VALUES(%s,%s,%s,%s,%s,now()+interval \'10 minutes\')',
            (token_hash, seal(s['key'], 'line-approval:' + str(intent_id), token), s['event_id'], intent_id, 'cd' * 32 if mutation == 'snapshot' else snapshot_hash))
        db.execute('INSERT INTO line_inbox(body_hash,body_cipher,signature) VALUES(%s,%s,%s)',
            (body_hash, seal(s['key'], 'line-body:' + body_hash, raw), 'tampered' if mutation == 'signature' else signature))
        db.execute('INSERT INTO line_order_actions(id,event_id,body_hash,token_hash,link_id,intent_id,action) VALUES(%s,%s,%s,%s,%s,%s,%s)',
            (action_id, postback['webhookEventId'], body_hash, token_hash, s['link_id'], intent_id, action))
        db.execute("INSERT INTO payment_envelopes(intent_id,envelope,payload,payload_hash) VALUES(%s,%s,%s,'fixture')", (intent_id,
            Jsonb({'risk': {'riskDigest': '0x' + '22' * 32}}), Jsonb({'extensions': {'yours.purchase': {'info': {'intentHash': '0x' + '11' * 32}}}})))
        if mutation == 'revoked': db.execute('UPDATE line_links SET revoked_at=now() WHERE id=%s', (s['link_id'],))
    return intent_id, action_id


def test_exact_line_postback_approves_once_without_wallet_signature_or_login_claim(line):
    intent, action = order_action(line)
    def approve(): return line['client'].post('/v1/approve-line-action', json={'action_id': str(action)})
    response = approve()
    assert response.status_code == 200, response.text
    assert response.json() == {'intentId': str(intent), 'status': 'authorized'}
    assert approve().json() == response.json()
    with line['pool'].connection() as db:
        rows = db.execute('SELECT * FROM approvals WHERE intent_id=%s', (intent,)).fetchall()
        assert len(rows) == 1
        assert rows[0]['proof']['overrideMask'] == 5
        assert rows[0]['owner_signature'] is None
        assert rows[0]['line_action_id'] == action
        assert rows[0]['line_login_attempt_id'] is None


@pytest.mark.parametrize('mutation', ['sender', 'token', 'stale', 'chat', 'snapshot', 'signature', 'revoked', 'reason'])
def test_line_button_never_overrides_identity_order_integrity_expiry_or_revocation(line, mutation):
    intent, action = order_action(line, mutation=mutation)
    response = line['client'].post('/v1/approve-line-action', json={'action_id': str(action)})
    assert response.status_code in (403, 422), response.text
    with line['pool'].connection() as db:
        assert db.execute('SELECT state FROM intents WHERE id=%s', (intent,)).fetchone()['state'] == 'approval_required'
        assert db.execute('SELECT count(*) AS n FROM approvals WHERE intent_id=%s', (intent,)).fetchone()['n'] == 0


def test_line_cancel_cannot_be_reinterpreted_as_approval(line):
    intent, action = order_action(line, action='cancel')
    response = line['client'].post('/v1/approve-line-action', json={'action_id': str(action)})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'canceled'
    with line['pool'].connection() as db:
        assert db.execute('SELECT count(*) AS n FROM approvals WHERE intent_id=%s', (intent,)).fetchone()['n'] == 0
        db.execute("UPDATE line_order_actions SET action='approve' WHERE id=%s", (action,))
    assert line['client'].post('/v1/approve-line-action', json={'action_id': str(action)}).status_code == 422
