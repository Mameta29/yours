import { JpycEcClient, type EcMerchant } from "@yours/jpyc-ec";
import { DomainError, digest } from "@yours/domain";
import { transaction, audit, enqueue, type Db } from "@yours/storage";
import { validateSchema } from "@yours/ucp";

/** Transfer is already canonical. This operation cannot sign or send funds. */
export async function settleEcOrder(
  db: Db,
  intentId: string,
  options: {
    merchants: EcMerchant[];
    chainId: number;
    token: string;
    test?: boolean;
  },
) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT r.*,i.id AS intent_id,i.state,i.transaction_hash,a.address,i.snapshot,o.id AS order_id FROM intents i JOIN accounts a ON a.id=i.account_id JOIN ec_reservations r ON r.checkout_id::text=i.checkout_id AND r.account_id=i.account_id AND r.connection_id=i.connection_id JOIN merchant_orders o ON o.session_id=r.checkout_id JOIN signed_transactions t ON t.intent_id=i.id AND t.state='confirmed' AND t.transaction_hash=i.transaction_hash WHERE i.id=$1`,
    [intentId],
  );
  if (!row || row.state !== "confirmed" || !row.authorized_at)
    throw new DomainError("ec_settlement_not_ready", 409);
  if (row.settled) return row.settled;
  const merchant = options.merchants.find((m) => m.id === row.merchant_id),
    quote = row.quote;
  if (
    !merchant ||
    quote.requirementsHash !== digest(quote.accepted) ||
    row.snapshot.checkout.yours.ec?.requirements_hash !==
      quote.requirementsHash ||
    quote.accepted.payTo.toLowerCase() !== merchant.payTo.toLowerCase() ||
    quote.accepted.asset.toLowerCase() !== options.token.toLowerCase() ||
    quote.accepted.network !== "eip155:" + options.chainId
  )
    throw new DomainError("ec_settlement_binding_mismatch", 409);
  const result = await new JpycEcClient(
    merchant,
    options.chainId,
    options.token,
    options.test,
  ).settle(quote, row.address, row.transaction_hash);
  return transaction(db, async (tx) => {
    const {
      rows: [current],
    } = await tx.query("SELECT * FROM ec_reservations WHERE id=$1 FOR UPDATE", [
      row.id,
    ]);
    if (current.settled) {
      if (current.settled.orderId !== result.orderId)
        throw new DomainError("ec_order_changed", 409);
      return current.settled;
    }
    const {
      rows: [order],
    } = await tx.query(
      "SELECT o.*,s.platform_profile FROM merchant_orders o JOIN merchant_sessions s ON s.id=o.session_id WHERE o.id=$1 FOR UPDATE OF o",
      [row.order_id],
    );
    const document = {
      ...order.document,
      yours: {
        ...order.document.yours,
        merchant_order: {
          status: "accepted",
          order_id: result.orderId,
          order_number: result.orderNumber,
          fulfillment_status: result.fulfillmentStatus,
        },
      },
    };
    validateSchema("shopping/order.json", document);
    await tx.query("UPDATE ec_reservations SET settled=$2 WHERE id=$1", [
      row.id,
      JSON.stringify(result),
    ]);
    await tx.query("UPDATE merchant_orders SET document=$2 WHERE id=$1", [
      order.id,
      JSON.stringify(document),
    ]);
    const eventId = "ec-order-accepted:" + order.id;
    await enqueue(tx, "order.webhook", eventId, {
      intentId,
      eventId,
      occurredAt: Math.floor(Date.now() / 1000),
      platformProfile: order.platform_profile,
      document,
    });
    await audit(tx, row.account_id, "worker", "ec.order.accepted", order.id, {
      intentId,
      merchantId: merchant.id,
      merchantOrderId: result.orderId,
      transactionHash: row.transaction_hash,
    });
    return result;
  });
}
