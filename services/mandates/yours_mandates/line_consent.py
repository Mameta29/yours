"""Wallet-signed standing authority; a webhook or an LLM is never authority alone."""
import base64
import hashlib
import hmac
import json
import time
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account
from eth_account.messages import encode_typed_data
from .consent import connection_hash, task_hash

LINE_SCOPE = 'Execute explicit purchase requests from this LINE account under my active yours policy. Exceptions require my explicit approval of that exact order from this LINE account.'


def unseal(key: str, purpose: str, value: str) -> str:
    version, iv, encrypted, tag = value.split('.')
    if version != 'v1':
        raise ValueError('invalid_cipher')
    decode = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
    return AESGCM(base64.b64decode(key, validate=True)).decrypt(decode(iv), decode(encrypted) + decode(tag), purpose.encode()).decode()


def user_hash(user_id: str) -> str:
    return hashlib.sha256(('line:' + user_id).encode()).hexdigest()


def line_consent_data(consent: dict, chain_id: int, gate: str) -> dict:
    return {
        'domain': {'name': 'yours LINE Consent', 'version': '1', 'chainId': chain_id, 'verifyingContract': gate},
        'types': {'LineConsent': [
            {'name': 'account', 'type': 'address'}, {'name': 'connectionId', 'type': 'bytes32'},
            {'name': 'lineUserHash', 'type': 'bytes32'}, {'name': 'policyId', 'type': 'bytes32'},
            {'name': 'emailHash', 'type': 'bytes32'}, {'name': 'scope', 'type': 'string'},
            {'name': 'nonce', 'type': 'bytes32'}, {'name': 'validUntil', 'type': 'uint64'},
        ]}, 'primaryType': 'LineConsent',
        'message': {'account': consent['account'], 'connectionId': connection_hash(consent['connectionId']),
            'lineUserHash': '0x' + consent['lineUserHash'], 'policyId': consent['policyId'],
            'emailHash': '0x' + consent['emailHash'], 'scope': LINE_SCOPE, 'nonce': consent['nonce'],
            'validUntil': consent['validUntil']},
    }


def verify_link(db, link_id, runtime, now=None):
    now = int(time.time()) if now is None else now
    row = db.execute('''SELECT l.*,a.address,c.status,c.provider,p.document AS permission,p.status AS permission_status,
        g.document AS policy,g.policy_id FROM line_links l JOIN accounts a ON a.id=l.account_id
        JOIN connections c ON c.id=l.connection_id JOIN permissions p ON p.connection_id=c.id
        JOIN policies g ON g.account_id=l.account_id WHERE l.id=%s''', (link_id,)).fetchone()
    if not row or not row['activated_at'] or row['revoked_at'] or not row['consent'] or not row['owner_signature']:
        raise ValueError('line_not_authorized')
    consent = row['consent']
    if row['status'] != 'active' or row['provider'] != 'gemini' or row['permission_status'] != 'active' or row['policy']['status'] != 'active':
        raise ValueError('line_permission_inactive')
    if min(row['expires_at'].timestamp(), consent['validUntil'], row['permission']['validUntil'], row['policy']['validUntil']) <= now:
        raise ValueError('line_permission_expired')
    if consent['account'] != row['address'] or consent['connectionId'] != str(row['connection_id']) or consent['lineUserHash'] != row['user_hash'] or consent['policyId'] != row['policy_id'] or consent['scope'] != LINE_SCOPE:
        raise ValueError('line_consent_modified')
    email = unseal(runtime.chat_key, 'line-email:' + str(row['id']), row['email_cipher'])
    if hashlib.sha256(email.encode()).hexdigest() != consent['emailHash']:
        raise ValueError('line_email_changed')
    recovered = Account.recover_message(encode_typed_data(full_message=line_consent_data(consent, runtime.chain_id, runtime.gate)), signature=row['owner_signature'])
    if recovered.lower() != row['address']:
        raise ValueError('invalid_line_owner_signature')
    return row


def verify_event(db, event_id, consent_row, runtime):
    if not runtime.chat_key or not (runtime.line_secret or runtime.line_bridge):
        raise ValueError('line_not_configured')
    event = db.execute('''SELECT e.*,b.body_cipher,b.signature,b.received_at FROM line_events e
        JOIN line_inbox b ON b.body_hash=e.body_hash WHERE e.id=%s''', (event_id,)).fetchone()
    if not event or event['consent_id'] != consent_row['id'] or consent_row['line_event_id'] != event['id']:
        raise ValueError('line_task_mismatch')
    link = verify_link(db, event['link_id'], runtime)
    if link['account_id'] != consent_row['account_id'] or link['connection_id'] != consent_row['connection_id']:
        raise ValueError('line_task_owner_mismatch')
    message, inbox = verified_channel_event(db, event['body_hash'], event['event_id'], runtime)
    if message.get('type') != 'message' or message.get('source', {}).get('type') != 'user' or message.get('message', {}).get('type') != 'text' or user_hash(message['source']['userId']) != link['user_hash']:
        raise ValueError('line_sender_mismatch')
    timestamp = message.get('timestamp', 0) / 1000
    if timestamp < link['activated_at'].timestamp() or abs(event['received_at'].timestamp() - timestamp) > 300:
        raise ValueError('line_event_stale')
    task, decision = consent_row['task'], event['decision']
    if not decision or decision.get('action') != 'purchase' or event['state'] in ('canceled', 'failed') or task_hash(task) != consent_row['task_hash']:
        raise ValueError('line_task_not_authorized')
    if task['merchant_id'] != decision['merchantId'] or task['max_amount'] != decision['amount'] or [(x['id'], x['quantity']) for x in task['items']] != [(decision['productId'], decision['quantity'])]:
        raise ValueError('line_selection_changed')
    if task['expires_at'] > min(link['consent']['validUntil'], link['permission']['validUntil'], link['policy']['validUntil']):
        raise ValueError('line_task_outlives_consent')
    return link, event


def verified_channel_event(db, body_hash, event_id, runtime):
    inbox = db.execute('SELECT * FROM line_inbox WHERE body_hash=%s', (body_hash,)).fetchone()
    if not inbox:
        raise ValueError('line_body_missing')
    raw = unseal(runtime.chat_key, 'line-body:' + body_hash, inbox['body_cipher'])
    if hashlib.sha256(raw.encode()).hexdigest() != body_hash:
        raise ValueError('line_body_modified')
    if runtime.line_secret:
        expected = base64.b64encode(hmac.new(runtime.line_secret.encode(), raw.encode(), hashlib.sha256).digest()).decode()
        if not hmac.compare_digest(expected, inbox['signature']):
            raise ValueError('line_webhook_invalid')
    else:
        # The enrolled EC keeps its original channel secret. The private
        # authority independently checks the original raw LINE signature there.
        from urllib.request import Request, urlopen
        from urllib.parse import urlparse
        if urlparse(runtime.line_bridge).scheme != 'https':
            raise ValueError('line_bridge_https_required')
        req = Request(runtime.line_bridge, data=json.dumps({'operation': 'verify', 'raw': raw, 'signature': inbox['signature']}).encode(), headers={'Content-Type': 'application/json'})
        with urlopen(req, timeout=8) as response:
            if response.geturl() != runtime.line_bridge or json.loads(response.read(65536)).get('valid') is not True:
                raise ValueError('line_webhook_invalid')
    matches = [e for e in json.loads(raw).get('events', []) if e.get('webhookEventId') == event_id]
    if len(matches) != 1:
        raise ValueError('line_event_invalid')
    return matches[0], inbox
