import { randomUUID } from 'node:crypto';
import { DomainError, sha256 } from '@yours/domain';
import { enqueue, transaction, type Db } from '@yours/storage';
import type { P256Signer } from '@yours/signing';
import type { Config } from './config.js';
import { notifyLine } from './line.js';
import { internalPost } from './internal.js';

export async function receiveLineAction(db: Db, bodyHash: string, event: any, link: any) {
  const match = /^yours:(approve|cancel):([A-Za-z0-9_-]{43})$/.exec(event.postback?.data ?? '');
  if (!match || !Number.isSafeInteger(event.timestamp) || Math.abs(Date.now() - event.timestamp) > 120000) return;
  await transaction(db, async tx => {
    await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [link.account_id]);
    const { rows: [target] } = await tx.query(`SELECT a.intent_id FROM line_approval_links a JOIN line_events e ON e.id=a.event_id
      JOIN intents i ON i.id=a.intent_id WHERE a.token_hash=$1 AND e.link_id=$2 AND a.expires_at>now() AND i.state='approval_required'`, [sha256(match[2]), link.id]);
    if (!target) return;
    const { rows: [action] } = await tx.query(`INSERT INTO line_order_actions(id,event_id,body_hash,token_hash,link_id,intent_id,action)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING RETURNING id`,
      [randomUUID(), event.webhookEventId, bodyHash, sha256(match[2]), link.id, target.intent_id, match[1]]);
    if (action) await enqueue(tx, 'line.approval', 'line-approval:' + action.id, { actionId: action.id });
  });
}

export async function processLineAction(db: Db, config: Config, signer: P256Signer, actionId: string) {
  const { rows: [action] } = await db.query(`SELECT a.*,l.event_id AS purchase_event FROM line_order_actions a
    JOIN line_approval_links l ON l.token_hash=a.token_hash WHERE a.id=$1`, [actionId]);
  if (!action || action.completed_at) return;
  try {
    const result = await internalPost<{ intentId: string; status: string }>(config, config.MANDATES_URL, '/v1/approve-line-action', { action_id: actionId });
    await transaction(db, async tx => {
      await tx.query('UPDATE line_order_actions SET completed_at=now() WHERE id=$1', [actionId]);
      if (result.status === 'authorized') await enqueue(tx, 'line.purchase', 'line-approved:' + actionId, { eventId: action.purchase_event });
    });
    if (result.status === 'canceled') await notifyLine(db, config, action.link_id, action.purchase_event, 'canceled', 'この注文を取り消しました。この注文の支払いは行いません。', [], signer);
    else if (result.status === 'authorized') await notifyLine(db, config, action.link_id, action.purchase_event, 'approved', 'この一件の承認を確認しました。元の購入条件は変えずに、支払いを再開します。', [], signer);
  } catch (error) {
    if (!(error instanceof DomainError) || ![400, 401, 403, 409, 422].includes(error.status)) throw error;
    await db.query('UPDATE line_order_actions SET completed_at=now(),last_error=$2 WHERE id=$1', [actionId, error.code]);
    await notifyLine(db, config, action.link_id, action.purchase_event, 'action-rejected:' + actionId,
      'この注文への承認を確認できませんでした。期限と連携状態を確認してください。注文が有効な場合は、同じ確認ボタンから再度お試しください。', [], signer);
  }
}
