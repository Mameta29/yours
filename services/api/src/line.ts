import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { recoverTypedDataAddress } from 'viem';
import { DomainError, sha256 } from '@yours/domain';
import { audit, enqueue, transaction, type Db, type Tx } from '@yours/storage';
import { owner, type Env } from './auth.js';
import type { Config } from './config.js';
import { channelUserHash, LINE_SCOPE, lineConsentData, seal, unseal } from './chat-security.js';
import { internalPost } from './internal.js';
import type { P256Signer } from '@yours/signing';
import { lineBridge, verifyIncomingLine } from './line-transport.js';
import { receiveLineAction } from './line-actions.js';

export function chatKey(config: Config) {
  if (!config.CHAT_ENCRYPTION_KEY || Buffer.from(config.CHAT_ENCRYPTION_KEY, 'base64').length !== 32) throw new DomainError('line_not_configured', 503);
  return config.CHAT_ENCRYPTION_KEY;
}
export async function wakeChat(config: Config) {
  if (!config.CHAT_WORKER_URL) return;
  // Work is already in SQL. A lost wake is recovered by Cloud Scheduler.
  try { await internalPost(config, config.CHAT_WORKER_URL, '/run', {}, 1200); } catch { /* durable retry */ }
}
async function lineRequest(config: Config, path: string, body?: unknown, retryKey?: string) {
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) throw new DomainError('line_not_configured', 503);
  return fetch('https://api.line.me' + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + config.LINE_CHANNEL_ACCESS_TOKEN, 'Content-Type': 'application/json', ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export type LineButton = { label: string; url: string } | { label: string; data: string; displayText: string };
export function lineText(text: string, buttons: LineButton[] = []) {
  const messages: any[] = [{ type: 'text', text: text.slice(0, 4800) }];
  if (buttons.length) messages.push({ type: 'template', altText: buttons[0].label,
    template: { type: 'buttons', text: 'yours · 注文の確認', actions: buttons.slice(0, 4).map(b => 'url' in b
      ? { type: 'uri', label: b.label.slice(0, 20), uri: b.url }
      : { type: 'postback', label: b.label.slice(0, 20), data: b.data, displayText: b.displayText }) } });
  return messages;
}
export async function queueLine(tx: Tx, linkId: string, key: string, document: unknown, eventId?: string) {
  const { rows: [row] } = await tx.query(`INSERT INTO line_messages(id,link_id,event_id,dedupe_key,document)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,
    [randomUUID(), linkId, eventId ?? null, key, JSON.stringify(document)]);
  await enqueue(tx, 'line.message', 'line-message:' + row.id, { messageId: row.id });
  return row.id as string;
}
export async function deliverLine(db: Db, config: Config, id: string, signer?: P256Signer) {
  const { rows: [row] } = await db.query('SELECT m.*,l.user_cipher FROM line_messages m JOIN line_links l ON l.id=m.link_id WHERE m.id=$1', [id]);
  if (!row || row.delivered_at) return;
  const to = unseal(chatKey(config), 'line-user:' + row.link_id, row.user_cipher);
  if (config.LINE_BRIDGE_URL) {
    if (!signer) throw new DomainError('line_bridge_signer_required', 503);
    const result = await lineBridge(config, signer, { operation: 'push', to, messages: row.document, retryKey: row.id });
    if (result.accepted !== true) throw new DomainError('line_delivery_failed', 503);
    await db.query('UPDATE line_messages SET delivered_at=coalesce(delivered_at,now()) WHERE id=$1', [id]);
    return;
  }
  const response = await lineRequest(config, '/v2/bot/message/push', { to, messages: row.document }, row.id);
  // LINE returns 409 with an accepted request ID for an already-used retry key.
  if (!response.ok && !(response.status === 409 && response.headers.get('x-line-accepted-request-id'))) throw new DomainError('line_delivery_failed', 503);
  await db.query('UPDATE line_messages SET delivered_at=coalesce(delivered_at,now()) WHERE id=$1', [id]);
}
export async function notifyLine(db: Db, config: Config, linkId: string, eventId: string, stage: string, text: string, buttons: LineButton[] = [], signer?: P256Signer) {
  const id = await transaction(db, tx => queueLine(tx, linkId, eventId + ':' + stage, lineText(text, buttons), eventId));
  try { await deliverLine(db, config, id, signer); } catch { /* Notifications cannot alter payment authority. */ }
}

export function lineOwnerRoutes(db: Db, config: Config) {
  const router = new Hono<Env>();
  router.get('/', async c => {
    const actor = owner(c);
    const bridge = config.LINE_BRIDGE_URL ? await lineBridge(config, undefined) : null;
    const { rows: links } = await db.query(`SELECT id,connection_id,display_name,user_hash IS NOT NULL AS claimed,consent,activated_at,revoked_at,expires_at,code_expires_at
      FROM line_links WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 5`, [actor.accountId]);
    const { rows: events } = await db.query(`SELECT e.id,e.state,e.decision,e.intent_id,e.last_error,e.created_at FROM line_events e JOIN line_links l ON l.id=e.link_id
      WHERE l.account_id=$1 ORDER BY e.created_at DESC LIMIT 20`, [actor.accountId]);
    return c.json({ configured: Boolean(config.CHAT_ENCRYPTION_KEY && (bridge?.configured || config.LINE_CHANNEL_ACCESS_TOKEN && config.LINE_CHANNEL_SECRET)),
      botId: bridge?.botId ?? config.LINE_BOT_ID, links, events });
  });
  router.post('/link', async c => {
    const actor = owner(c), key = chatKey(config);
    if (!config.LINE_BRIDGE_URL && (!config.LINE_CHANNEL_ACCESS_TOKEN || !config.LINE_CHANNEL_SECRET)) throw new DomainError('line_not_configured', 503);
    const { connectionId, email } = z.object({ connectionId: z.string().uuid(), email: z.string().email().max(254) }).strict().parse(await c.req.json());
    const id = randomUUID(), code = 'YOURS-' + randomBytes(12).toString('hex').toUpperCase();
    await transaction(db, async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [actor.accountId]);
      const { rows: [connection] } = await tx.query("SELECT id FROM connections WHERE id=$1 AND account_id=$2 AND status='active' AND provider='gemini'", [connectionId, actor.accountId]);
      if (!connection) throw new DomainError('permission_inactive', 403);
      await tx.query('UPDATE line_links SET revoked_at=now() WHERE account_id=$1 AND activated_at IS NULL AND revoked_at IS NULL', [actor.accountId]);
      await tx.query('INSERT INTO line_links(id,account_id,connection_id,code_hash,code_expires_at,email_cipher) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\',$5)',
        [id, actor.accountId, connectionId, sha256(code), seal(key, 'line-email:' + id, email)]);
    });
    const botId = config.LINE_BOT_ID ?? (config.LINE_BRIDGE_URL ? (await lineBridge(config, undefined)).botId : null);
    return c.json({ id, code, expiresIn: 600, url: botId ? 'https://line.me/R/oaMessage/' + encodeURIComponent(botId) + '/?' + encodeURIComponent(code) : null }, 201);
  });
  router.post('/:id/prepare', async c => {
    const actor = owner(c), id = z.string().uuid().parse(c.req.param('id'));
    if (!config.GATE_ADDRESS) throw new DomainError('payments_not_configured', 503);
    const result = await transaction(db, async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [actor.accountId]);
      const { rows: [row] } = await tx.query(`SELECT l.*,c.status,p.status AS permission_status,p.document AS permission,g.policy_id,g.document AS policy
        FROM line_links l JOIN connections c ON c.id=l.connection_id JOIN permissions p ON p.connection_id=c.id JOIN policies g ON g.account_id=l.account_id
        WHERE l.id=$1 AND l.account_id=$2 FOR UPDATE OF l`, [id, actor.accountId]);
      if (!row || row.revoked_at || !row.user_hash || row.activated_at) throw new DomainError('line_link_not_ready', 409);
      const now = Math.floor(Date.now() / 1000), validUntil = Math.min(row.permission.validUntil, row.policy.validUntil, now + 7 * 86400);
      if (row.status !== 'active' || row.permission_status !== 'active' || row.policy.status !== 'active' || validUntil <= now + 300) throw new DomainError('permission_inactive', 403);
      const consent = { account: actor.address, connectionId: row.connection_id, lineUserHash: row.user_hash, policyId: row.policy_id,
        emailHash: sha256(unseal(chatKey(config), 'line-email:' + id, row.email_cipher)), scope: LINE_SCOPE,
        nonce: '0x' + randomBytes(32).toString('hex'), validUntil };
      await tx.query('UPDATE line_links SET consent=$2,expires_at=to_timestamp($3) WHERE id=$1', [id, JSON.stringify(consent), validUntil]);
      return { id, displayName: row.display_name, typedData: lineConsentData(consent, config.CHAIN_ID, config.GATE_ADDRESS!), expiresAt: validUntil };
    });
    return c.json(result);
  });
  router.post('/:id/activate', async c => {
    const actor = owner(c), id = z.string().uuid().parse(c.req.param('id'));
    const { signature } = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict().parse(await c.req.json());
    await transaction(db, async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [actor.accountId]);
      const { rows: [row] } = await tx.query('SELECT l.*,p.policy_id FROM line_links l JOIN policies p ON p.account_id=l.account_id WHERE l.id=$1 AND l.account_id=$2 FOR UPDATE OF l', [id, actor.accountId]);
      if (!row || row.revoked_at || !row.consent || !row.user_hash || row.expires_at.getTime() <= Date.now() || row.policy_id !== row.consent.policyId) throw new DomainError('line_link_not_ready', 409);
      const address = await recoverTypedDataAddress({ ...lineConsentData(row.consent, config.CHAIN_ID, config.GATE_ADDRESS!), signature } as any);
      if (address.toLowerCase() !== actor.address) throw new DomainError('invalid_owner_signature', 403);
      const { rows: [other] } = await tx.query('SELECT id FROM line_links WHERE user_hash=$1 AND account_id<>$2 AND activated_at IS NOT NULL AND revoked_at IS NULL', [row.user_hash, actor.accountId]);
      if (other) throw new DomainError('line_already_linked', 409);
      await tx.query('UPDATE line_links SET revoked_at=now() WHERE account_id=$1 AND id<>$2 AND revoked_at IS NULL', [actor.accountId, id]);
      await tx.query('UPDATE line_links SET owner_signature=$2,activated_at=coalesce(activated_at,now()) WHERE id=$1', [id, signature]);
      await queueLine(tx, id, id + ':linked', lineText('yoursと連携しました。\n\n「お米10kg買っといて」のように依頼できます。設定した条件内で購入し、条件外なら支払い前に確認します。', [{ label: '権限を確認する', url: config.PUBLIC_ORIGIN + '/?view=line' }]));
      await audit(tx, actor.accountId, 'owner:' + actor.accountId, 'line.activated', id, { connectionId: row.connection_id });
    });
    await wakeChat(config);
    return c.json({ id, status: 'active' });
  });
  router.post('/:id/revoke', async c => {
    const actor = owner(c), id = z.string().uuid().parse(c.req.param('id'));
    await transaction(db, async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [actor.accountId]);
      await tx.query('UPDATE line_links SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND account_id=$2', [id, actor.accountId]);
      await audit(tx, actor.accountId, 'owner:' + actor.accountId, 'line.revoked', id);
    });
    return c.json({ status: 'revoked' });
  });
  return router;
}

export function lineWebhookRoutes(db: Db, config: Config, signer?: P256Signer) {
  const router = new Hono();
  router.post('/api/line/webhook', async c => {
    const raw = await c.req.text(), signature = c.req.header('x-line-signature');
    await verifyIncomingLine(config, raw, signature);
    const body = z.object({ events: z.array(z.record(z.unknown())).max(100) }).passthrough().parse(JSON.parse(raw));
    if (!body.events.length) return c.json({ received: true });
    const key = chatKey(config), bodyHash = sha256(raw), forwarded: string[] = [];
    await db.query('INSERT INTO line_inbox(body_hash,body_cipher,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [bodyHash, seal(key, 'line-body:' + bodyHash, raw), signature]);
    for (const event of body.events as any[]) {
      const userId = event.source?.type === 'user' && event.source.userId;
      if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/.test(userId) || typeof event.webhookEventId !== 'string') {
        if (event.webhookEventId) forwarded.push(event.webhookEventId); continue;
      }
      const userHash = channelUserHash(userId), message = event.type === 'message' && event.message?.type === 'text' ? String(event.message.text).trim() : '';
      // Once enrolled, a stopped/expired yours account must never fall back to
      // the legacy bot and its independently configured purchase permissions.
      const { rows: [linked] } = await db.query(`SELECT * FROM line_links WHERE user_hash=$1
        ORDER BY (activated_at IS NOT NULL AND revoked_at IS NULL) DESC,created_at DESC LIMIT 1`, [userHash]);
      if (event.type === 'unfollow' && linked) {
        await transaction(db, async tx => {
          await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [linked.account_id]);
          await tx.query('UPDATE line_links SET revoked_at=now() WHERE id=$1', [linked.id]);
          await audit(tx, linked.account_id, 'line', 'line.revoked', linked.id);
        }); continue;
      }
      if (/^YOURS-[0-9A-F]{24}$/i.test(message) && Math.abs(Date.now() - Number(event.timestamp)) < 300000) {
        let displayName = 'LINEユーザー';
        if (config.LINE_BRIDGE_URL) displayName = String((await lineBridge(config, signer, { operation: 'profile', userId })).displayName ?? displayName).slice(0, 80);
        else { const profile = await lineRequest(config, '/v2/bot/profile/' + userId); if (profile.ok) displayName = String((await profile.json() as any).displayName ?? displayName).slice(0, 80); }
        await transaction(db, async tx => {
          const { rows: [link] } = await tx.query('SELECT * FROM line_links WHERE code_hash=$1 AND code_expires_at>now() AND revoked_at IS NULL FOR UPDATE', [sha256(message.toUpperCase())]);
          if (!link || (link.user_hash && link.user_hash !== userHash) || link.activated_at) return;
          await tx.query('UPDATE line_links SET user_hash=$2,user_cipher=$3,display_name=$4 WHERE id=$1', [link.id, userHash, seal(key, 'line-user:' + link.id, userId), displayName]);
          await queueLine(tx, link.id, link.id + ':claimed', lineText('LINEを確認しました。yoursの設定画面に戻り、表示されたLINE名を確認して連携を完了してください。', [{ label: '設定画面を開く', url: config.PUBLIC_ORIGIN + '/?view=line' }]));
        }); continue;
      }
      if (!linked) { forwarded.push(event.webhookEventId); continue; }
      if (event.type === 'postback') { await receiveLineAction(db, bodyHash, event, linked); continue; }
      if (!message || message.length > 2000) continue;
      await transaction(db, async tx => {
        await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [linked.account_id]);
        if ((await tx.query('SELECT 1 FROM line_events WHERE event_id=$1', [event.webhookEventId])).rowCount) return;
        if (!Number.isSafeInteger(event.timestamp) || Math.abs(Date.now() - event.timestamp) > 300000) return;
        const { rows: [current] } = await tx.query('SELECT * FROM line_links WHERE id=$1', [linked.id]);
        if (!current.activated_at || current.revoked_at) {
          await queueLine(tx, linked.id, event.webhookEventId + ':inactive', lineText('LINEでの購入連携は停止中、または設定途中です。yoursで連携を確認してください。', [{ label: '設定を開く', url: config.PUBLIC_ORIGIN + '/?view=line' }])); return;
        }
        if (event.timestamp < current.activated_at.getTime()) return;
        if (/^(停止|ストップ|stop|\/stop)$/i.test(message)) {
          await tx.query('UPDATE line_links SET revoked_at=now() WHERE id=$1', [linked.id]);
          await queueLine(tx, linked.id, event.webhookEventId + ':stopped', lineText('LINEからの新しい購入を停止しました。送信済みの支払いは注文履歴で確認できます。', [{ label: 'yoursを開く', url: config.PUBLIC_ORIGIN + '/?view=line' }]));
          await audit(tx, linked.account_id, 'line', 'line.revoked', linked.id); return;
        }
        if (linked.expires_at.getTime() <= Date.now()) {
          await queueLine(tx, linked.id, event.webhookEventId + ':expired', lineText('連携の期限が切れています。yoursで購入権限とLINE連携を更新してください。', [{ label: '設定を開く', url: config.PUBLIC_ORIGIN + '/?view=line' }])); return;
        }
        const { rows: [rate] } = await tx.query('SELECT count(*)::int AS n FROM line_events e JOIN line_links l ON l.id=e.link_id WHERE l.account_id=$1 AND e.created_at>now()-interval \'1 hour\'', [linked.account_id]);
        if (rate.n >= 30) {
          await queueLine(tx, linked.id, event.webhookEventId + ':limit', lineText('依頼の回数が上限に達しました。少し時間をおいてお試しください。')); return;
        }
        const id = randomUUID();
        await tx.query('INSERT INTO line_events(id,event_id,body_hash,link_id) VALUES($1,$2,$3,$4)', [id, event.webhookEventId, bodyHash, linked.id]);
        await enqueue(tx, 'line.purchase', 'line-purchase:' + id, { eventId: id });
        await audit(tx, linked.account_id, 'line', 'line.request_received', id);
      });
    }
    if (forwarded.length && config.LINE_LEGACY_WEBHOOK) await transaction(db, tx => enqueue(tx, 'line.forward', 'line-forward:' + sha256(forwarded.slice().sort().join(',')), { bodyHash, eventIds: forwarded }));
    await wakeChat(config);
    return c.json({ received: true, handledIds: body.events.map((e: any) => e.webhookEventId).filter((id: any) => typeof id === 'string' && !forwarded.includes(id)) });
  });
  return router;
}

export async function forwardLegacyLine(db: Db, config: Config, bodyHash: string, eventIds: string[]) {
  if (!config.LINE_LEGACY_WEBHOOK || !config.LINE_CHANNEL_SECRET) return;
  const { rows: [row] } = await db.query('SELECT body_cipher FROM line_inbox WHERE body_hash=$1', [bodyHash]);
  if (!row) throw new DomainError('line_body_missing', 409);
  const source = JSON.parse(unseal(chatKey(config), 'line-body:' + bodyHash, row.body_cipher));
  const raw = JSON.stringify({ ...source, events: source.events.filter((e: any) => eventIds.includes(e.webhookEventId)) });
  const response = await fetch(config.LINE_LEGACY_WEBHOOK, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'x-line-signature': createHmac('sha256', config.LINE_CHANNEL_SECRET).update(raw).digest('base64') }, body: raw });
  if (!response.ok) throw new DomainError('legacy_line_unavailable', 503);
}
