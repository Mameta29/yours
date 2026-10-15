import { Hono } from 'hono';
import { z } from 'zod';
import { DomainError } from '@yours/domain';
import type { Db } from '@yours/storage';
import type { P256Signer } from '@yours/signing';
import type { Config } from './config.js';
import { requireWorker } from './webhooks.js';
import { processLinePurchase } from './chat-purchase.js';
import { deliverLine, forwardLegacyLine } from './line.js';
import { processLineAction } from './line-actions.js';

export function chatJobRoutes(db: Db, config: Config, signer: P256Signer) {
  const router = new Hono();
  router.post('/internal/line/process', async c => {
    await requireWorker(c, config, config.CHAT_WORKER_IDENTITY);
    const { workId, leaseToken } = z.object({ workId: z.string().uuid(), leaseToken: z.string().uuid() }).strict().parse(await c.req.json());
    const { rows: [work] } = await db.query(`SELECT * FROM outbox WHERE id=$1 AND lease_token=$2 AND lease_until>now()
      AND completed_at IS NULL AND topic=ANY($3)`, [workId, leaseToken, ['line.purchase', 'line.message', 'line.forward', 'line.approval']]);
    if (!work) throw new DomainError('line_work_not_leased', 409);
    if (work.topic === 'line.message') await deliverLine(db, config, z.string().uuid().parse(work.payload.messageId), signer);
    else if (work.topic === 'line.forward') await forwardLegacyLine(db, config, work.payload.bodyHash, work.payload.eventIds);
    else if (work.topic === 'line.approval') await processLineAction(db, config, signer, z.string().uuid().parse(work.payload.actionId));
    else return c.json({ pending: !await processLinePurchase(db, config, signer, z.string().uuid().parse(work.payload.eventId)) });
    return c.json({ pending: false });
  });
  return router;
}
