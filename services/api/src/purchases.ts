import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError } from "@yours/domain";
import { transaction, audit, enqueue, type Db } from "@yours/storage";
import { validateSchema } from "@yours/ucp";
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
  async function owned(c: any, byOrder = false) {
    const actor = owner(c),
      id = z
        .string()
        .uuid()
        .parse(c.req.param(byOrder ? "orderId" : "id"));
    const {
      rows: [row],
    } = await db.query(
      "SELECT i.*,o.document AS order_document,r.document AS receipts FROM intents i LEFT JOIN merchant_orders o ON o.session_id::text=i.checkout_id LEFT JOIN order_receipts r ON r.intent_id=i.id WHERE " +
        (byOrder ? "o.id" : "i.id") +
        "=$1 AND i.account_id=$2",
      [id, actor.accountId],
    );
    if (!row) throw new DomainError("purchase_not_found", 404);
    return row;
  }
  async function details(c: any, byOrder = false) {
    let row = await owned(c, byOrder);
    if (
      ["authorized", "signing", "submitted"].includes(row.state) ||
      (row.state === "confirmed" && !row.receipts)
    ) {
      await wakeSettlement(config, row.id);
      row = await owned(c, byOrder);
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
      createdAt: row.created_at,
      merchantName: row.snapshot.checkout.merchant.name,
      items: row.order_document?.line_items ?? row.snapshot.checkout.line_items,
    });
  }
  router.get("/orders/:orderId", (c) => details(c, true));
  router.get("/:id", (c) => details(c));
  async function deliveryFiles(row: any) {
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
    const productIds: string[] = [];
    for (const product of products) {
      const file = product.attributes.download;
      if (typeof file === "string" && files.has(file)) {
        contents.push(
          await readFile(
            new URL("../../../assets/market/" + file, import.meta.url),
            "utf8",
          ),
        );
        productIds.push(product.id);
      }
    }
    if (!contents.length) throw new DomainError("download_unavailable", 404);
    return { contents, productIds };
  }
  // Grant digital access explicitly. The GET download endpoint stays a read,
  // and a repeated click creates neither another event nor another webhook.
  router.post("/:id/delivery", async (c) => {
    const actor = owner(c),
      row = await owned(c);
    const { productIds } = await deliveryFiles(row);
    const downloadUrl = `/api/owner/purchases/${row.id}/download`;
    const document = await transaction(db, async (tx) => {
      const {
        rows: [order],
      } = await tx.query(
        "SELECT o.*,s.platform_profile FROM merchant_orders o JOIN merchant_sessions s ON s.id=o.session_id JOIN intents i ON i.checkout_id=o.session_id::text WHERE i.id=$1 AND i.account_id=$2 AND i.state='confirmed' FOR UPDATE OF o",
        [row.id, actor.accountId],
      );
      if (!order) throw new DomainError("settlement_not_confirmed", 409);
      const eventId = "digital-access:" + order.id;
      const previous = order.document.fulfillment.events ?? [];
      if (previous.some((event: any) => event.id === eventId))
        return order.document;
      const digital = new Set(productIds),
        lines = order.document.line_items.filter(
          (line: any) => digital.has(line.item.id) && line.quantity.total > 0,
        );
      if (!lines.length) throw new DomainError("download_unavailable", 404);
      const occurredAt = new Date();
      const updated = {
        ...order.document,
        line_items: order.document.line_items.map((line: any) =>
          digital.has(line.item.id) && line.quantity.total > 0
            ? {
                ...line,
                status: "fulfilled",
                quantity: { ...line.quantity, fulfilled: line.quantity.total },
              }
            : line,
        ),
        fulfillment: {
          ...order.document.fulfillment,
          events: [
            ...previous,
            {
              id: eventId,
              occurred_at: occurredAt.toISOString(),
              type: "digital_access_granted",
              line_items: lines.map((line: any) => ({
                id: line.id,
                quantity: line.quantity.total,
              })),
              description:
                "本人の購入ページからダウンロードできる状態にしました。",
              yours: { download_url: config.PUBLIC_ORIGIN + downloadUrl },
            },
          ],
        },
      };
      validateSchema("shopping/order.json", updated);
      await tx.query("UPDATE merchant_orders SET document=$2 WHERE id=$1", [
        order.id,
        JSON.stringify(updated),
      ]);
      await enqueue(tx, "order.webhook", eventId, {
        intentId: row.id,
        eventId,
        occurredAt: Math.floor(occurredAt.getTime() / 1000),
        platformProfile: order.platform_profile,
        document: updated,
      });
      await audit(
        tx,
        actor.accountId,
        "owner:" + actor.accountId,
        "order.digital_access_granted",
        order.id,
        { intentId: row.id },
      );
      return updated;
    });
    return c.json({ downloadUrl, order: document });
  });
  router.get("/:id/download", async (c) => {
    const row = await owned(c);
    const { contents } = await deliveryFiles(row);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      'attachment; filename="yours-' + row.id + '.md"',
    );
    return c.body(contents.join("\n\n---\n\n"));
  });
  return router;
}
