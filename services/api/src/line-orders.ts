import { Hono } from 'hono';
import { z } from 'zod';
import { DomainError, sha256 } from '@yours/domain';
import type { Db } from '@yours/storage';
import type { Config } from './config.js';
import { lineBridge } from './line-transport.js';
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Read-only order capability. Exception authority comes only from a signed
 * postback sent by the wallet-bound LINE account, never this browser page. */
export function lineOrderRoutes(db: Db, config: Config) {
  const router = new Hono();
  router.use('/api/line/*', async (c, next) => { c.header('Referrer-Policy', 'no-referrer'); await next(); });
  async function order(token: string) {
    tokenSchema.parse(token);
    const { rows: [row] } = await db.query(`SELECT a.event_id,a.expires_at AS link_expires,i.*,l.id AS link_id,l.revoked_at,l.expires_at AS consent_expires,
      e.decision,o.document AS order_document FROM line_approval_links a JOIN intents i ON i.id=a.intent_id JOIN line_events e ON e.id=a.event_id
      JOIN line_links l ON l.id=e.link_id LEFT JOIN merchant_orders o ON o.session_id::text=i.checkout_id WHERE a.token_hash=$1`, [sha256(token)]);
    if (!row) throw new DomainError('line_approval_not_found', 404);
    return row;
  }
  router.get('/api/line/approvals/:token', async c => {
    const row = await order(c.req.param('token'));
    return c.json({ id: row.id, state: row.state, amount: Number(row.amount_minor), currency: row.currency,
      merchant: row.snapshot.checkout.merchant.name, items: row.snapshot.checkout.line_items,
      reasons: row.reasons, snapshotHash: row.snapshot_hash, expiresAt: row.expires_at, transactionHash: row.transaction_hash,
      available: !row.revoked_at && row.link_expires.getTime() > Date.now() && row.consent_expires.getTime() > Date.now(),
      botId: config.LINE_BOT_ID ?? (config.LINE_BRIDGE_URL ? (await lineBridge(config, undefined)).botId : null),
      merchantOrder: row.order_document?.yours?.merchant_order ?? null, orderId: row.order_document?.id });
  });
  return router;
}
