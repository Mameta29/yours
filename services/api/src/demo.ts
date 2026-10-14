import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError, sha256 } from "@yours/domain";
import { transaction, type Db } from "@yours/storage";
import { requireOrigin } from "./auth.js";
import { internalPost } from "./internal.js";
import type { Config } from "./config.js";
/** Anonymous trial only has product-search tools. No wallet, tokens or writes. */
export function demoRoutes(db: Db, config: Config) {
  const router = new Hono();
  router.post("/runs", async (c) => {
    requireOrigin(c, config);
    if (!config.AGENT_URL) throw new DomainError("gemini_not_configured", 503);
    const { message } = z
      .object({ message: z.string().trim().min(1).max(500) })
      .strict()
      .parse(await c.req.json());
    const now = Date.now(),
      day = Math.floor(now / 86400000),
      hour = Math.floor(now / 3600000);
    // Cloud Run appends the connecting address. A forged prefix cannot evade
    // the per-address bucket; the global bucket also bounds total trial cost.
    const ip = (c.req.header("x-forwarded-for") ?? "local")
      .split(",")
      .at(-1)!
      .trim();
    await transaction(db, async (tx) => {
      for (const [key, max, ttl] of [
        [`demo:day:${day}`, 100, 86400],
        [`demo:ip:${sha256(ip)}:${hour}`, 10, 3600],
      ] as const) {
        const {
          rows: [row],
        } = await tx.query(
          "INSERT INTO api_rate_limits(key,count,expires_at) VALUES($1,1,now()+($2::int*interval '1 second')) ON CONFLICT(key) DO UPDATE SET count=api_rate_limits.count+1 RETURNING count",
          [key, ttl],
        );
        if (row.count > max) throw new DomainError("demo_rate_limit", 429);
      }
    });
    const id = randomUUID(),
      result = await internalPost(
        config,
        config.AGENT_URL,
        "/run",
        { run_id: id, message, agent_token: null, mandate_id: null },
        150000,
      );
    return c.json({ id, status: "completed", result });
  });
  return router;
}
