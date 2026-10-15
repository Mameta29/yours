import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { erc20Abi, parseEther } from 'viem';
import { processLinePurchase } from '../dist/chat-purchase.js';
import { processLineAction } from '../dist/line-actions.js';
import { executePayment } from '../../worker/dist/settlement.js';
import { settleEcOrder } from '../../worker/dist/ec-settlement.js';

/** Local boundary fixtures only for Gemini and LINE. UCP, AP2 authority,
 * delegation verification, ERC20 settlement and persistence are real. */
export async function lineIntegration({ db, app, config, signer, owner, connection, request, client, manifest, runtime, fixture, passed }) {
  const user = 'U' + randomBytes(16).toString('hex'), notifications = [], requests = [];
  fixture.setIssuer((await (await fetch(config.MANDATES_URL + '/v1/keys')).json()).issuer);
  const previous = { AGENT_URL: config.AGENT_URL, LINE_BRIDGE_URL: config.LINE_BRIDGE_URL, WORKER_URL: config.WORKER_URL };
  let quantity = 1;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let response;
      if (req.url === '/select') {
        requests.push(body);
        const product = body.products.find(p => p.merchantId === fixture.merchant.id);
        assert.ok(product); assert.ok(product.stock >= quantity);
        response = { action: 'purchase', product_id: product.id, quantity, explanation: '在庫がある外部ECの商品です。', model: 'local-selection-fixture', framework: 'transport-fixture' };
      } else if (req.url === '/run') {
        const result = await executePayment(db, body.intentId, runtime);
        if (result.state === 'submitted') {
          await client.request({ method: 'anvil_mine', params: ['0x5'] });
          assert.equal((await executePayment(db, body.intentId, runtime)).state, 'confirmed');
          await settleEcOrder(db, body.intentId, { merchants: [fixture.merchant], chainId: 31337, token: manifest.jpyc, test: true });
        }
        response = {};
      } else if (body.operation === 'profile') response = { displayName: 'LINE test owner' };
      else if (body.operation === 'push') { notifications.push(body); response = { accepted: true }; }
      else if (!raw) response = { configured: true, botId: '@fixture' };
      else throw new Error('unexpected_fixture_request');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
    } catch (error) {
      console.error('LINE integration fixture:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture_failed' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  Object.assign(config, { AGENT_URL: origin, LINE_BRIDGE_URL: origin + '/bridge', WORKER_URL: origin });
  async function webhook(event) {
    const raw = JSON.stringify({ events: [event] });
    const response = await app.request('/api/line/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': createHmac('sha256', config.LINE_CHANNEL_SECRET).update(raw).digest('base64') } });
    assert.equal(response.status, 200, await response.text());
  }
  const text = message => ({ webhookEventId: randomUUID(), type: 'message', timestamp: Date.now(), source: { type: 'user', userId: user }, message: { type: 'text', text: message } });
  try {
    const link = (await request('/api/owner/line/link', { connectionId: connection.id, email: 'buyer@example.test' }, { status: 201 })).json;
    await webhook(text(link.code));
    const draft = (await request('/api/owner/line/' + link.id + '/prepare', {})).json;
    await request('/api/owner/line/' + link.id + '/activate', { signature: await owner.signTypedData(draft.typedData) });
    const before = await client.readContract({ address: manifest.jpyc, abi: erc20Abi, functionName: 'balanceOf', args: [fixture.merchant.payTo] });
    const buy = text('お米を1点買って'); await webhook(buy); await webhook(buy);
    const event = (await db.query('SELECT * FROM line_events WHERE event_id=$1', [buy.webhookEventId])).rows[0];
    assert.ok(await processLinePurchase(db, config, signer, event.id));
    let row = (await db.query('SELECT * FROM line_events WHERE id=$1', [event.id])).rows[0];
    assert.equal(row.state, 'completed');
    assert.equal((await client.readContract({ address: manifest.jpyc, abi: erc20Abi, functionName: 'balanceOf', args: [fixture.merchant.payTo] })) - before, parseEther('800'));
    assert.equal((await db.query('SELECT owner_signature FROM task_consents WHERE id=$1', [row.consent_id])).rows[0].owner_signature, null);
    // Lose the final coordinator write, then resume the committed UCP intent.
    await db.query("UPDATE line_events SET intent_id=NULL,state='paying' WHERE id=$1", [event.id]);
    assert.ok(await processLinePurchase(db, config, signer, event.id));
    row = (await db.query('SELECT * FROM line_events WHERE id=$1', [event.id])).rows[0];
    assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1', [row.intent_id])).rows[0].n, 1);
    quantity = 3;
    const more = text('お米を3点買って'); await webhook(more);
    const held = (await db.query('SELECT * FROM line_events WHERE event_id=$1', [more.webhookEventId])).rows[0];
    assert.ok(await processLinePurchase(db, config, signer, held.id));
    const hold = (await db.query('SELECT * FROM line_events WHERE id=$1', [held.id])).rows[0];
    assert.equal(hold.state, 'approval_required');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1', [hold.intent_id])).rows[0].n, 0);
    const card = notifications.flatMap(n => n.messages).findLast(m => m.template?.actions?.some(a => a.type === 'postback'));
    assert.ok(card);
    const action = { webhookEventId: randomUUID(), type: 'postback', timestamp: Date.now(), source: { type: 'user', userId: user }, postback: { data: card.template.actions[0].data } };
    await webhook(action); await webhook(action);
    const queued = (await db.query('SELECT * FROM line_order_actions WHERE event_id=$1', [action.webhookEventId])).rows[0];
    await processLineAction(db, config, signer, queued.id);
    assert.ok(await processLinePurchase(db, config, signer, held.id));
    assert.equal((await db.query('SELECT state FROM line_events WHERE id=$1', [held.id])).rows[0].state, 'completed');
    await processLineAction(db, config, signer, queued.id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1', [hold.intent_id])).rows[0].n, 1);
    assert.equal((await client.readContract({ address: manifest.jpyc, abi: erc20Abi, functionName: 'balanceOf', args: [fixture.merchant.payTo] })) - before, parseEther('3200'));
    assert.equal(requests.length, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM approvals WHERE intent_id=$1 AND line_action_id IS NOT NULL', [hold.intent_id])).rows[0].n, 1);
    await webhook(text('停止'));
    assert.ok((await db.query('SELECT revoked_at FROM line_links WHERE id=$1', [link.id])).rows[0].revoked_at);
    passed.push('LINE wallet-bound standing consent executes an actual external ERC20 purchase',
      'duplicate LINE delivery and lost coordinator response produce one transfer',
      'LINE exception waits without broadcasting and registered account postback approves exactly one order',
      'real Gate enforces LINE-approved per-order and period-budget exceptions',
      'LINE stop revokes future authority without falling back to legacy bot');
  } finally {
    Object.assign(config, previous); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
