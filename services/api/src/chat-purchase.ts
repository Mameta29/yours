import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, digest, sha256 } from '@yours/domain';
import { audit, transaction, type Db } from '@yours/storage';
import type { P256Signer } from '@yours/signing';
import type { Config } from './config.js';
import { lineTextEvent, seal, unseal } from './chat-security.js';
import { chatKey, notifyLine, type LineButton } from './line.js';
import { verifyIncomingLine } from './line-transport.js';
import { internalPost, wakeSettlement } from './internal.js';
import { syncEcCatalog, merchants } from './merchants.js';
import { prepareTask } from './tasks.js';
import { authorizeEcCheckout } from './ec-checkout.js';

const selection = z.object({ action: z.enum(['purchase', 'browse', 'clarify']), product_id: z.string().max(256),
  quantity: z.number().int().min(1).max(100), explanation: z.string().min(1).max(600), model: z.string(), framework: z.string() }).strict();
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function processLinePurchase(db: Db, config: Config, signer: P256Signer, eventId: string, fetcher: Fetch = fetch): Promise<boolean> {
  const key = chatKey(config), deadline = Date.now() + 140000;
  const { rows: [event] } = await db.query(`SELECT e.*,l.account_id,l.connection_id,l.user_hash,l.email_cipher,l.activated_at,l.expires_at AS link_expires,
    l.revoked_at,a.address,b.body_cipher,b.signature FROM line_events e JOIN line_links l ON l.id=e.link_id
    JOIN accounts a ON a.id=l.account_id JOIN line_inbox b ON b.body_hash=e.body_hash WHERE e.id=$1`, [eventId]);
  if (!event || ['completed', 'failed', 'canceled'].includes(event.state)) return true;
  const say = (stage: string, text: string, buttons: LineButton[] = []) => notifyLine(db, config, event.link_id, eventId, stage, text, buttons, signer);
  const raw = unseal(key, 'line-body:' + event.body_hash, event.body_cipher);
  await verifyIncomingLine(config, raw, event.signature);
  const message = lineTextEvent(raw, event.event_id, event.user_hash).text;
  let runId: string | undefined, bearer: string | undefined;
  const protocol = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetcher(config.PUBLIC_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(65000), headers: { 'Content-Type': 'application/json', 'UCP-Agent': 'profile="' + config.PUBLIC_ORIGIN + '/.well-known/ucp"',
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    if (![200, 201, 202, 402].includes(response.status)) throw new DomainError(result.error ?? result.messages?.[0]?.code ?? 'chat_protocol_rejected', response.status);
    return result;
  };
  try {
    if (!event.intent_id && (event.revoked_at || event.link_expires.getTime() <= Date.now())) throw new DomainError('line_consent_inactive', 403);
    if (!event.decision) {
      if (event.created_at.getTime() < Date.now() - 15 * 60000) throw new DomainError('line_request_expired', 409);
      if (/^(権限|設定|ステータス|status|\/status)$/i.test(message)) {
        await say('status', '購入の範囲・共有予算・注文履歴はyoursで確認できます。', [{ label: '権限を確認する', url: config.PUBLIC_ORIGIN + '/?view=line' }]);
        await db.query("UPDATE line_events SET state='completed',updated_at=now() WHERE id=$1", [eventId]); return true;
      }
      if (/^(停止|ストップ|stop|\/stop)$/i.test(message)) {
        await transaction(db, async tx => {
          await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [event.account_id]);
          await tx.query('UPDATE line_links SET revoked_at=now() WHERE id=$1', [event.link_id]);
          await tx.query("UPDATE line_events SET state='completed',updated_at=now() WHERE id=$1", [eventId]);
          await audit(tx, event.account_id, 'line', 'line.revoked', event.link_id);
        });
        await say('stopped', 'LINEからの新しい購入を停止しました。送信済みの支払いは注文履歴で確認できます。', [{ label: '注文履歴を開く', url: config.PUBLIC_ORIGIN }]); return true;
      }
      await say('catalog', 'お店のカタログと最新の在庫を確認しています。');
      await db.query("UPDATE line_events SET state='selecting',updated_at=now() WHERE id=$1", [eventId]);
      await syncEcCatalog(db, config, true);
      const catalog: any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = await protocol('/ucp/catalog/search', { query: '', pagination: { limit: 10, ...(cursor ? { cursor } : {}) } });
        catalog.push(...response.products ?? []);
        if (!response.pagination?.has_next_page) break;
        cursor = response.pagination.cursor;
        if (!cursor || page === 9) throw new DomainError('catalog_too_large_for_chat', 409);
      }
      const { rows: inventory } = await db.query('SELECT * FROM merchant_products WHERE active=true AND id=ANY($1)', [catalog.map(p => p.id)]);
      const choices = catalog.filter(p => !p.metadata?.requires_shipping).map(p => {
        const stock = inventory.find(i => i.id === p.id);
        return { id: p.id, title: p.title, merchantId: p.metadata.merchant_id, merchant: p.metadata.merchant_name,
          amount: p.price_range.min.amount, stock: p.variants[0].availability.available && stock ? stock.stock : 0,
          maxQuantity: stock?.attributes?.maxQuantity ?? 100 };
      });
      const { rows: [previous] } = await db.query(`SELECT e.decision,e.event_id,e.body_hash,b.body_cipher,l.user_hash FROM line_events e JOIN line_links l ON l.id=e.link_id
        JOIN line_inbox b ON b.body_hash=e.body_hash WHERE l.account_id=$1 AND e.id<>$2 AND e.decision->>'action'='purchase' AND e.created_at<$3
        ORDER BY e.created_at DESC LIMIT 1`, [event.account_id, eventId, event.created_at]);
      const previousText = previous ? lineTextEvent(unseal(key, 'line-body:' + previous.body_hash, previous.body_cipher), previous.event_id, previous.user_hash).text : null;
      const answer = selection.parse(await internalPost(config, config.AGENT_URL, '/select', {
        message, products: choices, previous_request: previousText, previous_product: previous?.decision?.title ?? null,
      }, 70000));
      if (answer.action !== 'purchase') {
        await db.query("UPDATE line_events SET decision=$2,state='completed',updated_at=now() WHERE id=$1", [eventId, JSON.stringify(answer)]);
        await say('answer', answer.explanation); return true;
      }
      const product = choices.find(p => p.id === answer.product_id);
      if (!product || product.stock < answer.quantity || product.maxQuantity < answer.quantity || !Number.isSafeInteger(product.amount * answer.quantity)) throw new DomainError('ec_product_unavailable', 409);
      event.decision = { action: 'purchase', productId: product.id, merchantId: product.merchantId, merchant: product.merchant, title: product.title,
        quantity: answer.quantity, amount: product.amount * answer.quantity, explanation: answer.explanation, model: answer.model, framework: answer.framework };
      await transaction(db, async tx => {
        await tx.query('UPDATE line_events SET decision=$2,state=\'preparing\',updated_at=now() WHERE id=$1 AND decision IS NULL', [eventId, JSON.stringify(event.decision)]);
        await audit(tx, event.account_id, 'gemini', 'line.product_selected', eventId, { productId: product.id, amount: event.decision.amount, model: answer.model });
      });
    }
    const d = event.decision;
    await say('selection', `${d.explanation}\n\n${d.merchant}\n${d.title} × ${d.quantity}\n合計 ¥${d.amount.toLocaleString('ja-JP')} test JPYC\n\nあなたの購入条件を確認します。`);
    if (!event.consent_id) {
      const owner = { kind: 'owner' as const, accountId: event.account_id, address: event.address, authenticatedAt: event.activated_at };
      const task = await prepareTask(db, config, signer, owner, { connectionId: event.connection_id, merchantId: d.merchantId,
        items: [{ id: d.productId, quantity: d.quantity }], maxAmount: d.amount, minutes: 15, requestId: eventId,
        email: unseal(key, 'line-email:' + event.link_id, event.email_cipher) });
      await transaction(db, async tx => {
        await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [event.account_id]);
        await tx.query('UPDATE line_events SET consent_id=$2 WHERE id=$1 AND consent_id IS NULL', [eventId, task.id]);
        await tx.query('UPDATE task_consents SET line_event_id=$2 WHERE id=$1 AND line_event_id IS NULL', [task.id, eventId]);
      });
      event.consent_id = task.id;
    }
    if (!event.mandate_id) {
      if (merchants(config).find(m => m.id === d.merchantId)?.adapter === 'jpyc-ec') {
        const delegation = await internalPost<{ proof: string }>(config, config.MANDATES_URL, '/v1/ec-delegation', { consent_id: event.consent_id, line_event_id: eventId });
        await authorizeEcCheckout(db, config, signer, { kind: 'owner', accountId: event.account_id, address: event.address, authenticatedAt: event.activated_at }, event.consent_id, undefined, delegation.proof);
      }
      const issued = await internalPost<{ id: string }>(config, config.MANDATES_URL, '/v1/issue', { consent_id: event.consent_id, line_event_id: eventId });
      event.mandate_id = issued.id;
      await db.query('UPDATE line_events SET mandate_id=$2 WHERE id=$1', [eventId, issued.id]);
    }
    // UCP completion may have committed while the HTTP response was lost.
    // Recover its one existing intent instead of trying to complete it again.
    if (!event.intent_id) {
      const { rows: [consumed] } = await db.query('SELECT intent_id FROM mandate_consumptions WHERE mandate_id=$1', [event.mandate_id]);
      if (consumed) {
        event.intent_id = consumed.intent_id;
        await db.query("UPDATE line_events SET intent_id=$2,state='paying',updated_at=now() WHERE id=$1", [eventId, event.intent_id]);
      }
    }
    bearer = randomBytes(32).toString('base64url');
    const { rows: [run] } = await db.query(`INSERT INTO agent_runs(id,account_id,connection_id,mandate_id,client_request_id,token_hash,message,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'running',now()+interval '5 minutes') ON CONFLICT(account_id,client_request_id)
      DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,status='running' RETURNING id`,
      [randomUUID(), event.account_id, event.connection_id, event.mandate_id, eventId, sha256(bearer), message]);
    runId = run.id;
    if (!event.intent_id) {
      const { rows: [task] } = await db.query('SELECT task FROM mandates WHERE id=$1', [event.mandate_id]);
      const checkout = task.task.checkout_id ? await protocol('/ucp/checkout-sessions/' + task.task.checkout_id)
        : await protocol('/ucp/checkout-sessions', { line_items: [{ item: { id: d.productId }, quantity: d.quantity }] }, { 'Idempotency-Key': 'task:' + event.mandate_id + ':checkout' });
      if (checkout.status !== 'ready_for_complete') throw new DomainError('checkout_not_ready', 409);
      const presented = await protocol('/api/agent/present', { mandateId: event.mandate_id, checkoutId: checkout.id });
      const complete = await protocol('/ucp/checkout-sessions/' + checkout.id + '/complete', {
        payment: { instruments: [{ id: presented.instrumentId, handler_id: 'yours-stablecoin', type: 'stablecoin', selected: true,
          credential: { type: 'yours_ap2', mandate_id: event.mandate_id } }] }, ap2: presented.mandates,
      }, { 'Idempotency-Key': 'task:' + event.mandate_id + ':complete', 'If-Match': '"' + checkout.yours.revision + '"' });
      event.intent_id = z.string().uuid().parse(complete.yours?.intent_id);
      await db.query("UPDATE line_events SET intent_id=$2,state='paying',updated_at=now() WHERE id=$1", [eventId, event.intent_id]);
    }
    await wakeSettlement(config, event.intent_id);
    for (let step = 0; step < 6 && Date.now() < deadline; step++) {
      const { rows: [intent] } = await db.query('SELECT i.*,e.accepted_at,e.payload,o.document AS order_document,r.settled FROM intents i LEFT JOIN payment_envelopes e ON e.intent_id=i.id LEFT JOIN merchant_orders o ON o.session_id::text=i.checkout_id LEFT JOIN ec_reservations r ON r.checkout_id::text=i.checkout_id WHERE i.id=$1', [event.intent_id]);
      if (!intent) throw new DomainError('payment_not_found', 404);
      if (intent.state === 'confirmed' && intent.transaction_hash) {
        if (d.merchantId !== config.MERCHANT_ID && !intent.settled) {
          await say('settlement', 'チェーン上で支払いが確定しました。お店での注文受付を確認しています。');
          await wakeSettlement(config, intent.id); return false;
        }
        const orderId = intent.order_document?.id;
        const result = `${d.merchant}で購入しました。\n\n${d.title} × ${d.quantity}\n¥${d.amount.toLocaleString('ja-JP')} test JPYC\n${intent.settled ? '店舗の注文番号: ' + intent.settled.orderNumber + '\n' : ''}\n代金はあなたのウォレットから支払いました。`;
        await say('confirmed', result, [ ...(orderId ? [{ label: '注文の詳細', url: config.PUBLIC_ORIGIN + '/orders/' + orderId }] : []), { label: '支払いを確認する', url: 'https://amoy.polygonscan.com/tx/' + intent.transaction_hash } ]);
        await db.query("UPDATE line_events SET state='completed',updated_at=now(),last_error=NULL WHERE id=$1", [eventId]);
        await db.query("UPDATE agent_runs SET status='completed',result=$2 WHERE id=$1", [runId, JSON.stringify({ text: result, events: [{ type: 'payment.confirmed', intentId: intent.id, transactionHash: intent.transaction_hash }], model: d.model, framework: d.framework, channel: 'LINE' })]);
        return true;
      }
      if (['failed', 'canceled'].includes(intent.state)) throw new DomainError('payment_' + intent.state, 409);
      if (!intent.accepted_at && intent.payload) {
        const challenge = await protocol('/api/agent/payments/' + intent.id);
        const authorization = await protocol('/api/agent/payments/' + intent.id + '/authorization');
        if (challenge.x402Version === 2 && authorization.paymentPayload) {
          const payload = authorization.paymentPayload;
          if (!challenge.accepts.some((a: any) => digest(a) === digest(payload.accepted)) || digest(challenge.extensions) !== digest(payload.extensions)) throw new DomainError('payment_requirements_changed', 409);
          await protocol('/api/agent/payments/' + intent.id, {}, { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') });
        }
      }
      if (intent.state === 'approval_required') {
        const url = await lineApprovalUrl(db, config, event, intent);
        const token = url.split('/').at(-1)!;
        const labels: Record<string, string> = { per_order: '1回の上限を超えています', period_budget: '期間の予算を超えています', merchant: '購入を許可したお店の範囲外です' };
        await say('approval', `購入条件の範囲外のため、支払いを止めています。\n\n${d.title} × ${d.quantity}\n${d.merchant} · ¥${d.amount.toLocaleString('ja-JP')} test JPYC\n${intent.reasons.map((r: string) => labels[r] ?? r).join('\n')}\n\nこの注文だけ許可する場合は、下のボタンを押してください。元の購入条件は変更しません。`, [
          { label: 'この一件だけ許可', data: 'yours:approve:' + token, displayText: `${d.merchant}の「${d.title}」×${d.quantity}、¥${d.amount.toLocaleString('ja-JP')}の一件だけ許可する` },
          { label: '今回は買わない', data: 'yours:cancel:' + token, displayText: 'この注文を取り消す' },
          { label: '注文の詳細', url }]);
        await db.query("UPDATE line_events SET state='approval_required',updated_at=now() WHERE id=$1", [eventId]);
        await db.query("UPDATE agent_runs SET status='completed',result=$2 WHERE id=$1", [runId, JSON.stringify({ text: 'LINEで注文内容の確認と本人の一件承認を待っています。', events: [{ type: 'payment.approval_required', intentId: intent.id }], model: d.model, framework: d.framework, channel: 'LINE' })]);
        return true;
      }
      if (intent.accepted_at && ['authorized', 'signing', 'submitted'].includes(intent.state))
        await say('paying', '購入条件と同意を確認しました。あなたのウォレットから支払いを進めています。');
      await wakeSettlement(config, intent.id);
    }
    return false;
  } catch (error) {
    const code = error instanceof DomainError ? error.code : 'chat_dependency_unavailable';
    await db.query('UPDATE line_events SET last_error=$2,updated_at=now() WHERE id=$1', [eventId, code]);
    const permanent = error instanceof DomainError && [400, 401, 403, 404, 409, 422].includes(error.status);
    if (permanent && !event.intent_id) {
      await db.query("UPDATE line_events SET state='failed' WHERE id=$1", [eventId]);
      const texts: Record<string, string> = { ec_product_unavailable: '選んだ商品の在庫を確保できませんでした。支払いは行っていません。もう一度依頼すると最新の在庫から探します。', permission_inactive: '購入権限が停止中か期限切れです。yoursで設定を確認してください。', line_consent_inactive: 'LINEの購入連携が停止中か期限切れです。yoursで設定を確認してください。', line_request_expired: '依頼から時間が経ったため、自動購入を止めました。購入する場合はもう一度依頼してください。' };
      await say('failed', texts[code] ?? 'この依頼の購入条件を確認できなかったため、支払いを止めました。yoursで権限をご確認ください。', [{ label: 'yoursを開く', url: config.PUBLIC_ORIGIN }]);
      return true;
    }
    if (event.intent_id && ['payment_failed', 'payment_canceled'].includes(code)) {
      await db.query("UPDATE line_events SET state='failed' WHERE id=$1", [eventId]);
      await say('failed', 'この注文は成立しませんでした。支払い状況はyoursの注文履歴で確認できます。', [{ label: '注文履歴を開く', url: config.PUBLIC_ORIGIN }]); return true;
    }
    await say('pending', '処理結果を確認しています。確認が済むと、このトークへお知らせします。同じ依頼を送り直す必要はありません。');
    throw error;
  } finally {
    if (runId) await db.query('UPDATE agent_runs SET token_hash=NULL WHERE id=$1', [runId]);
  }
}

export async function lineApprovalUrl(db: Db, config: Config, event: any, intent: any) {
  return transaction(db, async tx => {
    const { rows: [old] } = await tx.query('SELECT * FROM line_approval_links WHERE intent_id=$1', [intent.id]);
    if (old) {
      if (old.snapshot_hash !== intent.snapshot_hash) throw new DomainError('line_order_changed', 409);
      return config.PUBLIC_ORIGIN + '/line/approve/' + unseal(chatKey(config), 'line-approval:' + intent.id, old.token_cipher);
    }
    const token = randomBytes(32).toString('base64url');
    await tx.query('INSERT INTO line_approval_links(token_hash,token_cipher,event_id,intent_id,expires_at,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [sha256(token), seal(chatKey(config), 'line-approval:' + intent.id, token), event.id, intent.id, intent.expires_at, intent.snapshot_hash]);
    return config.PUBLIC_ORIGIN + '/line/approve/' + token;
  });
}
