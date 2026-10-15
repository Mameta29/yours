import { randomUUID, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError, sha256 } from "@yours/domain";
import { transaction, audit, type Db } from "@yours/storage";
import { owner, type Env } from "./auth.js";
import { internalPost } from "./internal.js";
import type { Config } from "./config.js";
const input = z
  .object({
    requestId: z.string().uuid(),
    message: z.string().trim().min(1).max(2000),
    connectionId: z.string().uuid().optional(),
    mandateId: z.string().uuid().optional(),
  })
  .strict();
export function runRoutes(db: Db, config: Config) {
  const router = new Hono<Env>();
  router.get("/", async (c) => {
    const a = owner(c);
    const { rows } = await db.query(
      "SELECT id,client_request_id,connection_id,mandate_id,message,status,result,created_at FROM agent_runs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 20",
      [a.accountId],
    );
    return c.json({ runs: rows });
  });
  router.post("/", async (c) => {
    const actor = owner(c),
      body = input.parse(await c.req.json());
    if (!config.AGENT_URL) throw new DomainError("gemini_not_configured", 503);
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const run = await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        actor.accountId,
      ]);
      const {
        rows: [old],
      } = await tx.query(
        "SELECT * FROM agent_runs WHERE account_id=$1 AND client_request_id=$2",
        [actor.accountId, body.requestId],
      );
      if (old) {
        if (
          old.message !== body.message ||
          old.connection_id !== (body.connectionId ?? null) ||
          old.mandate_id !== (body.mandateId ?? null)
        )
          throw new DomainError("idempotency_conflict", 409);
        return old;
      }
      const {
        rows: [rate],
      } = await tx.query(
        "SELECT count(*)::int AS n FROM agent_runs WHERE account_id=$1 AND created_at>now()-interval '1 hour'",
        [actor.accountId],
      );
      if (rate.n >= 30) throw new DomainError("agent_rate_limit", 429);
      if (body.connectionId) {
        const {
          rows: [connection],
        } = await tx.query(
          "SELECT id FROM connections WHERE id=$1 AND account_id=$2 AND provider='gemini' AND status='active'",
          [body.connectionId, actor.accountId],
        );
        if (!connection) throw new DomainError("connection_inactive", 403);
        if (
          body.mandateId &&
          !(
            await tx.query(
              "SELECT 1 FROM mandates WHERE id=$1 AND connection_id=$2 AND revoked_at IS NULL AND expires_at>now()",
              [body.mandateId, body.connectionId],
            )
          ).rowCount
        )
          throw new DomainError("task_not_available", 403);
      } else if (body.mandateId)
        throw new DomainError("connection_required", 422);
      const {
        rows: [row],
      } = await tx.query(
        "INSERT INTO agent_runs(id,account_id,connection_id,mandate_id,client_request_id,token_hash,message,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'running',now()+interval '5 minutes') RETURNING *",
        [
          id,
          actor.accountId,
          body.connectionId ?? null,
          body.mandateId ?? null,
          body.requestId,
          body.connectionId ? sha256(token) : null,
          body.message,
        ],
      );
      await audit(
        tx,
        actor.accountId,
        "owner:" + actor.accountId,
        "agent.started",
        id,
        { connectionId: body.connectionId ?? null },
      );
      return row;
    });
    if (run.id !== id)
      return c.json({ id: run.id, status: run.status, result: run.result });
    try {
      const result = await internalPost(
        config,
        config.AGENT_URL,
        "/run",
        {
          run_id: id,
          message: body.message,
          agent_token: body.connectionId ? token : null,
          mandate_id: body.mandateId ?? null,
        },
        150000,
      );
      await db.query(
        "UPDATE agent_runs SET status='completed',result=$2,token_hash=NULL WHERE id=$1",
        [id, JSON.stringify(result)],
      );
      return c.json({ id, status: "completed", result });
    } catch (error) {
      await db.query(
        "UPDATE agent_runs SET status='failed',result=$2,token_hash=NULL WHERE id=$1",
        [
          id,
          JSON.stringify({
            error: "agent_unavailable",
            message: "実行結果を注文履歴で確認してください。",
          }),
        ],
      );
      throw error;
    }
  });
  return router;
}
