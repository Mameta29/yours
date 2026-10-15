import { JpycEcClient, parseMerchants, type EcMerchant } from "@yours/jpyc-ec";
import { DomainError } from "@yours/domain";
import { transaction, type Db } from "@yours/storage";
import type { Config } from "./config.js";

export function ecMerchants(config: Config) {
  return parseMerchants(config.EC_MERCHANTS_JSON, config.NODE_ENV === "test");
}
export function merchants(config: Config) {
  return [
    {
      id: config.MERCHANT_ID,
      name: config.MERCHANT_NAME,
      origin: config.PUBLIC_ORIGIN,
      payTo: config.MERCHANT_PAY_TO,
      adapter: "local",
    },
    ...ecMerchants(config).map((m) => ({ ...m, adapter: "jpyc-ec" })),
  ];
}
export function merchantFor(config: Config, id: string) {
  const merchant = merchants(config).find((m) => m.id === id);
  if (!merchant?.payTo) throw new DomainError("merchant_not_enrolled", 422);
  return { ...merchant, payTo: merchant.payTo };
}
export function ecClient(config: Config, merchant: EcMerchant) {
  if (!config.JPYC_ADDRESS)
    throw new DomainError("payments_not_configured", 503);
  return new JpycEcClient(
    merchant,
    config.CHAIN_ID,
    config.JPYC_ADDRESS,
    config.NODE_ENV === "test",
  );
}
const refreshes = new WeakMap<
  Db,
  Map<string, { expires: number; pending?: Promise<void> }>
>();
/** External stock is a search cache. Every purchase obtains a fresh real EC quote. */
export async function syncEcCatalog(db: Db, config: Config, force = false) {
  let cache = refreshes.get(db);
  if (!cache) {
    cache = new Map();
    refreshes.set(db, cache);
  }
  await Promise.all(
    ecMerchants(config).map(async (merchant) => {
      const previous = cache!.get(merchant.id);
      if (previous?.pending) return previous.pending;
      if (!force && previous && previous.expires > Date.now()) return;
      const entry: { expires: number; pending?: Promise<void> } = {
        expires: Date.now() + 60000,
      };
      const pending = (async () => {
        try {
          const products = await ecClient(config, merchant).catalog();
          await transaction(db, async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
              "catalog:" + merchant.id,
            ]);
            await tx.query(
              "UPDATE merchant_products SET active=false WHERE merchant_id=$1",
              [merchant.id],
            );
            for (const product of products)
              await tx.query(
                `INSERT INTO merchant_products(merchant_id,id,title,description,currency,amount_minor,stock,attributes) VALUES($1,$2,$3,$4,'JPY',$5,$6,$7) ON CONFLICT(merchant_id,id) DO UPDATE SET title=excluded.title,description=excluded.description,amount_minor=excluded.amount_minor,stock=excluded.stock,attributes=excluded.attributes,active=true`,
                [
                  merchant.id,
                  merchant.id + "/" + product.id,
                  product.title,
                  product.description,
                  product.amountMinor,
                  product.available ? product.stock : 0,
                  JSON.stringify({
                    external: true,
                    maxQuantity: product.maxQuantity,
                    syncedAt: new Date().toISOString(),
                  }),
                ],
              );
          });
        } catch (error) {
          // Keep local goods available, but do not offer stale external stock as buyable.
          await db.query(
            "UPDATE merchant_products SET stock=0 WHERE merchant_id=$1",
            [merchant.id],
          );
          console.warn(
            JSON.stringify({
              event: "ec_catalog_unavailable",
              merchantId: merchant.id,
              code:
                error instanceof DomainError ? error.code : "dependency_error",
            }),
          );
        }
      })();
      entry.pending = pending;
      cache!.set(merchant.id, entry);
      try {
        await pending;
      } finally {
        entry.pending = undefined;
      }
    }),
  );
}
