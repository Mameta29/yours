import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createDb, migrate } from '@yours/storage';
import { sha256 } from '@yours/domain';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { lineApprovalUrl } from '../src/chat-purchase.js';
import { unseal } from '../src/chat-security.js';

const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/yours_test');
const key = randomBytes(32).toString('base64'), gate = '0x' + '12'.repeat(20);
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer = { kid: 'line-test', publicJwk: { ...pair.publicKey.export({ format: 'jwk' }), kid: 'line-test', alg: 'ES256', use: 'sig' },
  sign: async (bytes: Uint8Array) => new Uint8Array(sign('sha256', bytes, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' })) };
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/yours_test', PUBLIC_ORIGIN: 'http://localhost:8080',
  GATE_ADDRESS: gate, CHAT_ENCRYPTION_KEY: key, LINE_CHANNEL_SECRET: 'test-channel', LINE_CHANNEL_ACCESS_TOKEN: 'test-only', LINE_BOT_ID: '@test',
 });
const app = createApp(db, config, signer);
beforeAll(async () => {
  await migrate(db);
  // Only the external LINE profile transport is doubled; routes, database,
  // HMAC verification and wallet signatures run without mocks.
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).startsWith('https://api.line.me/v2/bot/profile/')) return Response.json({ displayName: 'Test owner' });
    throw new Error('unexpected_network_request');
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await db.end(); });
async function fixture() {
  const wallet = privateKeyToAccount(generatePrivateKey()), account = randomUUID(), connection = randomUUID(), session = randomBytes(32).toString('base64url');
  const user = 'U' + randomBytes(16).toString('hex'), until = Math.floor(Date.now() / 1000) + 3600;
  await db.query('INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,80002)', [account, wallet.address.toLowerCase()]);
  await db.query("INSERT INTO connections(id,account_id,name,provider,agent_address,status) VALUES($1,$2,'Gemini','gemini',$3,'active')", [connection, account, '0x' + randomBytes(20).toString('hex')]);
  await db.query("INSERT INTO permissions(connection_id,revision,document,owner_signature,status) VALUES($1,1,$2,'fixture','active')", [connection, JSON.stringify({ validUntil: until })]);
  await db.query("INSERT INTO policies(account_id,policy_id,revision,gate_address,token_address,token_decimals,currency,document) VALUES($1,$2,1,$3,$3,18,'JPY',$4)", [account, '0x' + randomBytes(32).toString('hex'), gate, JSON.stringify({ status: 'active', validUntil: until })]);
  await db.query("INSERT INTO owner_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(session), account]);
  const headers = { Origin: config.PUBLIC_ORIGIN, Cookie: 'yours_session=' + session, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const link = await (await post('/api/owner/line/link', { connectionId: connection, email: 'test@example.test' })).json();
  const event = (text: string, id = randomUUID(), source = user) => ({ webhookEventId: id, timestamp: Date.now(), type: 'message', source: { type: 'user', userId: source }, message: { type: 'text', text } });
  const webhook = (events: unknown[], valid = true) => {
    const raw = JSON.stringify({ events });
    return app.request('/api/line/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': valid ? createHmac('sha256', 'test-channel').update(raw).digest('base64') : 'invalid' } });
  };
  const activate = async () => {
    expect((await webhook([event(link.code)])).status).toBe(200);
    const draft = await (await post('/api/owner/line/' + link.id + '/prepare', {})).json();
    const signature = await wallet.signTypedData(draft.typedData);
    expect((await post('/api/owner/line/' + link.id + '/activate', { signature })).status).toBe(200);
  };
  return { wallet, account, connection, user, headers, post, link, event, webhook, activate };
}
it('requires a wallet signature over the claimed LINE identity before queueing a purchase', async () => {
  const f = await fixture();
  expect((await f.webhook([f.event(f.link.code)], false)).status).toBe(401);
  expect((await f.post('/api/owner/line/' + f.link.id + '/prepare', {})).status).toBe(409);
  await f.webhook([f.event(f.link.code)]);
  const draft = await (await f.post('/api/owner/line/' + f.link.id + '/prepare', {})).json();
  const wrong = await privateKeyToAccount(generatePrivateKey()).signTypedData(draft.typedData);
  expect((await f.post('/api/owner/line/' + f.link.id + '/activate', { signature: wrong })).status).toBe(403);
  const message = f.event('お米10kg買っといて');
  expect((await (await f.webhook([message])).json()).handledIds).toContain(message.webhookEventId);
  expect((await db.query('SELECT id FROM line_events WHERE link_id=$1', [f.link.id])).rowCount).toBe(0);
  await f.activate();
  const first = f.event('お米10kg買っといて');
  await f.webhook([first]); await f.webhook([first]);
  expect((await db.query('SELECT id FROM line_events WHERE link_id=$1', [f.link.id])).rowCount).toBe(1);
  const stored = (await db.query('SELECT * FROM line_links WHERE id=$1', [f.link.id])).rows[0];
  expect(unseal(key, 'line-user:' + f.link.id, stored.user_cipher)).toBe(f.user);
  expect(JSON.stringify(stored)).not.toContain(f.user);
});
it('stops immediately and never sends a stopped user back to the legacy purchasing bot', async () => {
  const f = await fixture(); await f.activate();
  const stop = f.event('停止');
  expect((await (await f.webhook([stop])).json()).handledIds).toContain(stop.webhookEventId);
  expect((await db.query('SELECT revoked_at FROM line_links WHERE id=$1', [f.link.id])).rows[0].revoked_at).toBeTruthy();
  const retry = f.event('お米10kg買っといて');
  expect((await (await f.webhook([retry])).json()).handledIds).toContain(retry.webhookEventId);
  expect((await db.query('SELECT id FROM line_events WHERE link_id=$1', [f.link.id])).rowCount).toBe(0);
});
it('does not claim unrelated legacy users and rejects stale purchase events', async () => {
  const f = await fixture(); await f.activate();
  const unrelated = f.event('お米10kg買っといて', randomUUID(), 'U' + randomBytes(16).toString('hex'));
  expect((await (await f.webhook([unrelated])).json()).handledIds).toEqual([]);
  await f.webhook([{ ...f.event('お米10kg買っといて'), timestamp: Date.now() - 600001 }]);
  expect((await db.query('SELECT id FROM line_events WHERE link_id=$1', [f.link.id])).rowCount).toBe(0);
});
it('keeps wallet sessions separate and requires same-origin owner changes', async () => {
  const f = await fixture(), other = await fixture(); await f.activate();
  expect((await other.post('/api/owner/line/' + f.link.id + '/prepare', {})).status).toBe(409);
  const foreign = await app.request('/api/owner/line/link', { method: 'POST', headers: { ...f.headers, Origin: 'https://evil.example' }, body: JSON.stringify({ connectionId: f.connection, email: 'test@example.test' }) });
  expect(foreign.status).toBe(403);
});
it('binds the LINE confirmation to one immutable order and rejects browser or foreign-account approval', async () => {
  const f = await fixture(); await f.activate();
  await f.webhook([f.event('お米10kg買っといて')]);
  const event = (await db.query('SELECT * FROM line_events WHERE link_id=$1', [f.link.id])).rows[0];
  const intentId = randomUUID(), hash = 'ab'.repeat(32);
  await db.query(`INSERT INTO intents(id,account_id,connection_id,merchant_id,checkout_id,revision,currency,amount_minor,amount_atomic,period_index,state,snapshot,snapshot_hash,reasons,expires_at)
    VALUES($1,$2,$3,'test','test','1','JPY',2400,2400000000000000000000,0,'approval_required',$4,$5,'["per_order"]',now()+interval '10 minutes')`,
    [intentId, f.account, f.connection, JSON.stringify({ checkout: { merchant: { name: 'HIGH' }, line_items: [] } }), hash]);
  const intent = (await db.query('SELECT * FROM intents WHERE id=$1', [intentId])).rows[0];
  const url = await lineApprovalUrl(db, config, event, intent), token = url.split('/').at(-1), path = '/api/line/approvals/' + token;
  expect((await app.request(path)).status).toBe(200);
  expect((await f.post(path + '/approve', {})).status).toBe(404);
  const postback = { ...f.event(''), type: 'postback', message: undefined, postback: { data: 'yours:approve:' + token } };
  const other = await fixture(); await other.activate();
  await other.webhook([{ ...postback, source: { type: 'user', userId: other.user } }]);
  expect((await db.query('SELECT id FROM line_order_actions WHERE intent_id=$1', [intentId])).rowCount).toBe(0);
  await f.webhook([postback]); await f.webhook([postback]);
  expect((await db.query('SELECT id FROM line_order_actions WHERE intent_id=$1', [intentId])).rowCount).toBe(1);
  expect((await db.query('SELECT state FROM intents WHERE id=$1', [intentId])).rows[0].state).toBe('approval_required');
  await expect(lineApprovalUrl(db, config, event, { ...intent, snapshot_hash: 'cd'.repeat(32) })).rejects.toThrow('line_order_changed');
});
