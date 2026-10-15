"""One-order consent from the registered LINE account, not LINE re-login.

The original authenticated postback must bind the immutable quote, wallet-
signed LINE identity and a single-use order capability. A URL, LLM response,
forwarded screenshot or chat text is never exception authority.
"""
import hashlib
import time
from .line_consent import verify_link, verified_channel_event, user_hash


def verify_order_action(db, action_id, runtime):
    action = db.execute('SELECT * FROM line_order_actions WHERE id=%s', (action_id,)).fetchone()
    if not action:
        raise ValueError('line_action_not_found')
    link = verify_link(db, action['link_id'], runtime)
    target = db.execute('SELECT a.*,e.link_id FROM line_approval_links a JOIN line_events e ON e.id=a.event_id WHERE a.token_hash=%s', (action['token_hash'],)).fetchone()
    intent = db.execute('SELECT * FROM intents WHERE id=%s', (action['intent_id'],)).fetchone()
    now = int(time.time())
    if not target or not intent or target['intent_id'] != intent['id'] or target['link_id'] != link['id'] or intent['account_id'] != link['account_id'] or intent['connection_id'] != link['connection_id'] or target['snapshot_hash'] != intent['snapshot_hash'] or min(target['expires_at'].timestamp(), intent['expires_at'].timestamp()) <= now:
        raise ValueError('line_order_changed_or_expired')
    event, inbox = verified_channel_event(db, action['body_hash'], action['event_id'], runtime)
    if event.get('type') != 'postback' or event.get('source', {}).get('type') != 'user' or user_hash(event.get('source', {}).get('userId', '')) != link['user_hash']:
        raise ValueError('line_confirmation_sender_mismatch')
    parts = event.get('postback', {}).get('data', '').split(':')
    if len(parts) != 3 or parts[:2] != ['yours', action['action']] or hashlib.sha256(parts[2].encode()).hexdigest() != action['token_hash']:
        raise ValueError('line_confirmation_order_mismatch')
    timestamp = event.get('timestamp')
    if type(timestamp) is not int:
        raise ValueError('line_confirmation_invalid_time')
    confirmed_at = timestamp // 1000
    if not max(now - 120, int(target['created_at'].timestamp()), int(link['activated_at'].timestamp())) <= confirmed_at <= now + 5 or abs(inbox['received_at'].timestamp() - timestamp / 1000) > 120:
        raise ValueError('line_confirmation_expired')
    return action, link, intent, confirmed_at
