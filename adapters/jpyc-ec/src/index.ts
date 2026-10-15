import { z } from "zod";
import { DomainError, digest } from "@yours/domain";
import { safeRequest } from "@yours/ucp";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const amount = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/);
const merchantSchema = z
  .object({
    id: z.string().regex(/^ec:[a-z0-9-]+$/),
    name: z.string().min(1).max(160),
    origin: z.string().url(),
    shopId: z.string().uuid(),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    payTo: address,
  })
  .strict();
export type EcMerchant = z.infer<typeof merchantSchema>;
export function parseMerchants(json = "[]", test = false): EcMerchant[] {
  const list = z.array(merchantSchema).max(16).parse(JSON.parse(json));
  if (new Set(list.map((m) => m.id)).size !== list.length)
    throw new Error("duplicate_merchant");
  for (const m of list) {
    const u = new URL(m.origin);
    if (
      u.origin !== m.origin ||
      u.username ||
      u.password ||
      !(
        u.protocol === "https:" ||
        (test &&
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname))
      ) ||
      /^0x0{40}$/i.test(m.payTo)
    )
      throw new Error("invalid_merchant_configuration");
  }
  return list;
}
/** No floating point conversion of JPYC. UCP JPY uses whole-yen minor units. */
export function wholeJpy(value: unknown): number {
  const text = amount.parse(value),
    [integer, fraction = ""] = text.split(".");
  if (/[^0]/.test(fraction))
    throw new DomainError("ec_fractional_price_unsupported", 422);
  const result = Number(integer);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new DomainError("ec_amount_invalid", 422);
  return result;
}
const productSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    description: z.string().nullable().optional(),
    price_jpyc: amount,
    stock: z.number().int().nonnegative(),
    max_quantity_per_order: z.number().int().positive().nullable().optional(),
    requires_shipping: z.boolean(),
    variants: z.unknown().nullable(),
    online_purchase_available: z.boolean(),
    online_sale_status: z.string().optional(),
  })
  .passthrough();
export type EcProduct = {
  id: string;
  title: string;
  description: string;
  amountMinor: number;
  stock: number;
  maxQuantity: number;
  available: boolean;
};
const requirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string(),
    amount: z.string().regex(/^[1-9][0-9]*$/),
    asset: address,
    payTo: address,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z
      .object({
        assetTransferMethod: z.literal("erc20-transfer"),
        decimals: z.literal(18),
        payerAuthorization: z
          .object({
            scheme: z.literal("personal_sign"),
            verifier: z.literal("erc1271"),
            version: z.literal("1"),
            message: z.string().max(4096),
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();
export type EcQuote = {
  reservationId: string;
  expiresAt: number;
  amountMinor: number;
  accepted: z.infer<typeof requirementsSchema>;
  requirementsHash: string;
  message: string;
  items: { id: string; title: string; quantity: number; price: number }[];
};
export type EcReservationInput = {
  requestId: string;
  payer: string;
  items: { id: string; quantity: number }[];
  email: string;
  maxAmount: number;
};
export class JpycEcClient {
  constructor(
    readonly merchant: EcMerchant,
    readonly chainId: number,
    readonly token: string,
    readonly test = false,
  ) {
    parseMerchants(JSON.stringify([merchant]), test);
    if (chainId !== 80002 && !(test && chainId === 31337))
      throw new Error("ec_amoy_required");
    address.parse(token);
  }
  private async request(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await safeRequest(this.merchant.origin + path, {
      allowedOrigins: new Set([this.merchant.origin]),
      allowLoopback: this.test,
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.from(JSON.stringify(body)) }),
      maxBytes: 262144,
      timeout: 20000,
    });
    if (!response.headers["content-type"]?.includes("application/json"))
      throw new DomainError("ec_invalid_response", 502);
    let data: any;
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new DomainError("ec_invalid_response", 502);
    }
    return { ...response, json: data };
  }
  async catalog(): Promise<EcProduct[]> {
    const response = await this.request(
      "/api/v1/shops/" + this.merchant.slug + "/products",
    );
    if (response.status !== 200 || response.json.ok !== true)
      throw new DomainError("ec_catalog_unavailable", 502);
    const data = response.json.data,
      shop = data?.shop;
    if (
      !shop ||
      shop.id !== this.merchant.shopId ||
      shop.slug !== this.merchant.slug ||
      shop.is_demo !== false ||
      shop.x402_enabled !== true ||
      shop.wallet_address?.toLowerCase() !==
        this.merchant.payTo.toLowerCase() ||
      !shop.available_chains?.includes(this.chainId)
    )
      throw new DomainError("ec_merchant_changed", 409);
    // Fail closed on products needing choices the current checkout UI cannot collect.
    if (
      !Array.isArray(shop.checkout_options) ||
      shop.checkout_options.some((option: any) => option.required)
    )
      throw new DomainError("ec_checkout_options_unsupported", 422);
    const products = z.array(productSchema).max(1000).parse(data.products);
    return products
      .filter((p) => !p.requires_shipping && !p.variants)
      .map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description ?? "",
        amountMinor: wholeJpy(p.price_jpyc),
        stock: p.stock,
        maxQuantity: p.max_quantity_per_order ?? 10000,
        available: p.online_purchase_available && p.stock > 0,
      }))
      .filter((p) => p.amountMinor > 0);
  }
  async reserve(input: EcReservationInput): Promise<EcQuote> {
    z.string().uuid().parse(input.requestId);
    address.parse(input.payer);
    z.string().email().max(254).parse(input.email);
    z.array(
      z
        .object({
          id: z.string().uuid(),
          quantity: z.number().int().min(1).max(10000),
        })
        .strict(),
    )
      .min(1)
      .max(50)
      .parse(input.items);
    if (new Set(input.items.map((i) => i.id)).size !== input.items.length)
      throw new DomainError("duplicate_line_item", 422);
    const catalog = await this.catalog();
    let expected = 0;
    for (const item of input.items) {
      const product = catalog.find((p) => p.id === item.id);
      if (
        !product ||
        !product.available ||
        item.quantity > Math.min(product.stock, product.maxQuantity)
      )
        throw new DomainError("ec_product_unavailable", 409);
      expected += product.amountMinor * item.quantity;
    }
    if (
      !Number.isSafeInteger(expected) ||
      expected <= 0 ||
      expected > input.maxAmount
    )
      throw new DomainError("ec_price_changed", 409);
    const response = await this.request("/api/v1/checkout", {
      shop_id: this.merchant.shopId,
      preferred_chain_id: this.chainId,
      items: input.items.map((i) => ({
        product_id: i.id,
        quantity: i.quantity,
      })),
      customer_email: input.email,
      payer_address: input.payer.toLowerCase(),
      transfer_authorization_version: "1",
      idempotency_key: input.requestId,
    });
    if (
      response.status !== 402 ||
      response.json.error?.code !== "payment_required"
    )
      throw new DomainError("ec_reservation_rejected", 409);
    let required: any;
    try {
      required = JSON.parse(
        Buffer.from(
          z.string().max(65536).parse(response.headers["payment-required"]),
          "base64url",
        ).toString("utf8"),
      );
    } catch {
      throw new DomainError("ec_payment_required_invalid", 502);
    }
    const data = response.json.data;
    const reservationId = z
      .string()
      .regex(/^res_[0-9a-f]{32}$/)
      .parse(data?.reservation_id);
    const expiresAt = z.number().int().safe().parse(data?.expires_at_unix_ms);
    if (expiresAt <= Date.now() + 120000 || expiresAt > Date.now() + 86400000)
      throw new DomainError("ec_quote_expiring", 409);
    const total = wholeJpy(data?.summary?.total_jpyc);
    if (
      total !== expected ||
      wholeJpy(data.summary.subtotal_jpyc) !== expected ||
      [
        "discount_jpyc",
        "shipping_jpyc",
        "checkout_options_surcharge_jpyc",
      ].some((k) => wholeJpy(data.summary[k]) !== 0)
    )
      throw new DomainError("ec_quote_changed", 409);
    if (
      required.x402Version !== 2 ||
      required.resource?.url !== this.merchant.origin + "/api/v1/checkout" ||
      !Array.isArray(required.accepts)
    )
      throw new DomainError("ec_payment_required_invalid", 502);
    const acceptedOptions = required.accepts.filter(
      (a: any) => a.extra?.assetTransferMethod === "erc20-transfer",
    );
    if (acceptedOptions.length !== 1)
      throw new DomainError("ec_transfer_unavailable", 422);
    const accepted = requirementsSchema.parse(acceptedOptions[0]);
    if (
      accepted.network !== "eip155:" + this.chainId ||
      accepted.asset.toLowerCase() !== this.token.toLowerCase() ||
      accepted.payTo.toLowerCase() !== this.merchant.payTo.toLowerCase() ||
      BigInt(accepted.amount) !== BigInt(total) * 10n ** 18n
    )
      throw new DomainError("ec_payment_binding_mismatch", 422);
    const message = [
      "JPYC EC payment authorization",
      "",
      "I authorize one JPYC payment for this checkout reservation.",
      "Signing this message does not transfer tokens or grant token approval.",
      "",
      "Version: 1",
      `Reservation ID: ${reservationId}`,
      `Chain ID: ${this.chainId}`,
      `Payer: ${input.payer.toLowerCase()}`,
      `Payee: ${this.merchant.payTo.toLowerCase()}`,
      `Amount: ${data.summary.total_jpyc} JPYC`,
      `Amount (atomic): ${accepted.amount}`,
      `Expires at (Unix ms): ${expiresAt}`,
    ].join("\n");
    if (accepted.extra.payerAuthorization.message !== message)
      throw new DomainError("ec_authorization_message_mismatch", 422);
    return {
      reservationId,
      expiresAt,
      amountMinor: total,
      accepted,
      requirementsHash: digest(accepted),
      message,
      items: input.items.map((item) => ({
        ...item,
        title: catalog.find((p) => p.id === item.id)!.title,
        price: catalog.find((p) => p.id === item.id)!.amountMinor,
      })),
    };
  }
  async authorize(quote: EcQuote, signature?: string, delegationProof?: string) {
    if (Boolean(signature) === Boolean(delegationProof)) throw new DomainError('ec_exactly_one_proof_required', 422);
    if (signature) z.string().regex(/^0x[0-9a-fA-F]{130}$/).parse(signature);
    if (delegationProof) z.string().min(100).max(16384).parse(delegationProof);
    if (quote.expiresAt <= Date.now())
      throw new DomainError("ec_quote_expired", 409);
    const response = await this.request("/api/v1/checkout/authorize-transfer", {
      reservation_id: quote.reservationId,
      ...(delegationProof ? { delegation_proof: delegationProof } : { signature }),
    });
    if (
      response.status !== 200 ||
      response.json.ok !== true ||
      response.json.data?.authorized !== true ||
      response.json.data?.expires_at_unix_ms !== quote.expiresAt
    )
      throw new DomainError("ec_owner_authorization_rejected", 409);
  }
  async settle(quote: EcQuote, payer: string, transactionHash: string) {
    address.parse(payer);
    hash.parse(transactionHash);
    if (digest(quote.accepted) !== quote.requirementsHash)
      throw new DomainError("ec_quote_changed", 409);
    const payload = {
      x402Version: 2,
      accepted: quote.accepted,
      payload: { payerAddress: payer.toLowerCase(), txHash: transactionHash },
    };
    const response = await this.request(
      "/api/v1/checkout",
      { reservation_id: quote.reservationId },
      {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString(
          "base64url",
        ),
      },
    );
    if (response.status !== 200 || response.json.ok !== true)
      throw new DomainError("ec_settlement_pending", 503);
    const data = z
      .object({
        order_id: z.string().uuid(),
        order_number: z.string().min(1).max(100),
        tx_hash: hash,
        network: z.string(),
        payer: address,
        amount_atomic: z.string().regex(/^[1-9][0-9]*$/),
        is_demo: z.literal(false),
        fulfillment_status: z
          .enum(["ready", "needs_review", "resolved"])
          .optional(),
      })
      .parse(response.json.data);
    if (
      data.tx_hash.toLowerCase() !== transactionHash.toLowerCase() ||
      data.network !== quote.accepted.network ||
      data.payer.toLowerCase() !== payer.toLowerCase() ||
      data.amount_atomic !== quote.accepted.amount
    )
      throw new DomainError("ec_settlement_mismatch", 409);
    // "ready" is order readiness, not proof that a product was delivered.
    return {
      orderId: data.order_id,
      orderNumber: data.order_number,
      fulfillmentStatus: data.fulfillment_status ?? "ready",
      transactionHash: data.tx_hash,
    };
  }
}
