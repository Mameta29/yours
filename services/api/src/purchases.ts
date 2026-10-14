import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError } from "@yours/domain";
import type { Db } from "@yours/storage";
import { owner, type Env } from "./auth.js";
import type { Config } from "./config.js";
import { wakeSettlement } from "./internal.js";
const files = new Set([
  "weekly-review.md",
  "travel-checklist.md",
  "project-kit.md",
]);
export function purchaseRoutes(db: Db, config: Config) {
  const router = new Hono<Env>();
  async function owned(c: any) {
    const actor = owner(c),
      id = z.string().uuid().parse(c.req.param("id"));
    const {
      rows: [row],
    } = await db.query(
      "SELECT i.*,o.document AS order_document,r.document AS receipts FROM intents i LEFT JOIN merchant_orders o ON o.session_id::text=i.checkout_id LEFT JOIN order_receipts r ON r.intent_id=i.id WHERE i.id=$1 AND i.account_id=$2",
      [id, actor.accountId],
    );
    if (!row) throw new DomainError("purchase_not_found", 404);
    return row;
  }
  router.get("/:id", async (c) => {
    let row = await owned(c);
    if (["authorized", "signing", "submitted"].includes(row.state)) {
      await wakeSettlement(config, row.id);
      row = await owned(c);
    }
    return c.json({
      id: row.id,
      state: row.state,
      amount: Number(row.amount_minor),
      currency: row.currency,
      transactionHash: row.transaction_hash,
      order: row.order_document,
      receipts: row.receipts,
      expiresAt: row.expires_at,
    });
  });
  router.get("/:id/download", async (c) => {
    const row = await owned(c);
    if (row.state !== "confirmed" || !row.order_document)
      throw new DomainError("settlement_not_confirmed", 409);
    if (row.merchant_id !== config.MERCHANT_ID)
      throw new DomainError("merchant_delivery_external", 409);
    const ids = row.order_document.line_items.map((line: any) => line.item.id);
    const { rows: products } = await db.query(
      "SELECT id,attributes FROM merchant_products WHERE merchant_id=$1 AND id=ANY($2)",
      [row.merchant_id, ids],
    );
    const contents = [];
    for (const product of products) {
      const file = product.attributes.download;
      if (typeof file === "string" && files.has(file))
        contents.push(
          await readFile(
            new URL("../../../assets/market/" + file, import.meta.url),
            "utf8",
          ),
        );
    }
    if (!contents.length) throw new DomainError("download_unavailable", 404);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      'attachment; filename="yours-' + row.id + '.md"',
    );
    return c.body(contents.join("\n\n---\n\n"));
  });
  return router;
}
