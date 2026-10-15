/** Private Cloud Run chat queue. Separate from settlement to avoid recursive
 * calls deadlocking a single-concurrency payment worker. No model/wallet keys. */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GoogleAuth } from 'google-auth-library';
import { createDb, claimWork, finishWork } from '@yours/storage';

const database = process.env.DATABASE_URL, origin = process.env.PUBLIC_ORIGIN;
if (!database || !origin || new URL(origin).protocol !== 'https:') throw new Error('chat_worker_configuration_required');
const db = createDb(database), auth = new GoogleAuth(), app = new Hono();
app.use('*', bodyLimit({ maxSize: 1024 }));
app.get('/health', c => c.json({ ok: true, service: 'yours-chat' }));
app.post('/run', async c => {
  const deadline = Date.now() + 150000;
  let processed = 0, pending = 0;
  for (let i = 0; i < 16 && Date.now() < deadline; i++) {
    const work = await claimWork(db, ['line.approval'], 180)
      ?? await claimWork(db, ['line.purchase', 'line.message', 'line.forward'], 180);
    if (!work) break;
    try {
      const client = await auth.getIdTokenClient(origin);
      const token = await client.idTokenProvider.fetchIdToken(origin);
      const response = await fetch(origin + '/internal/line/process', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(160000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ workId: work.id, leaseToken: work.lease_token }) });
      if (!response.ok) throw new Error('chat_work_retry');
      const result = await response.json() as { pending: boolean };
      await finishWork(db, work, result.pending ? 'awaiting_payment' : undefined);
      if (result.pending) { pending++; break; } else processed++;
    } catch {
      await finishWork(db, work, 'chat_dependency_unavailable'); pending++;
      console.warn(JSON.stringify({ event: 'chat_work_retry', workId: work.id }));
      break;
    }
  }
  return c.json({ processed, pending });
});
app.onError((_error, c) => c.json({ error: 'chat_worker_unavailable' }, 503));
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080), hostname: '0.0.0.0' });
process.on('SIGTERM', () => server.close(() => void db.end()));
