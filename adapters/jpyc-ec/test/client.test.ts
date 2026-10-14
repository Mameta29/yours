import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  JpycEcClient,
  parseMerchants,
  wholeJpy,
  type EcMerchant,
} from "../src/index.js";

describe("pinned legacy EC protocol boundary", () => {
  let server: Server,
    client: JpycEcClient,
    merchant: EcMerchant,
    change: (v: any) => void,
    received: any[];
  const payer = "0x" + "11".repeat(20),
    token = "0x" + "22".repeat(20),
    payTo = "0x" + "33".repeat(20),
    product = randomUUID(),
    tx = "0x" + "44".repeat(32),
    orderId = randomUUID();
  beforeEach(async () => {
    change = () => {};
    received = [];
    server = createServer(async (req, res) => {
      let text = "";
      for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : {};
      received.push({
        path: req.url,
        body,
        signature: req.headers["payment-signature"],
      });
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/products")) {
        const result = {
          ok: true,
          data: {
            shop: {
              id: merchant.shopId,
              slug: merchant.slug,
              wallet_address: payTo,
              available_chains: [31337],
              is_demo: false,
              x402_enabled: true,
              checkout_options: [],
            },
            products: [
              {
                id: product,
                name: "Rice",
                description: "Test",
                price_jpyc: "800.000000000000000000",
                stock: 20,
                requires_shipping: false,
                variants: null,
                online_purchase_available: true,
              },
            ],
          },
        };
        change(result);
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url?.endsWith("/authorize-transfer")) {
        res.end(
          JSON.stringify({
            ok: true,
            data: { authorized: true, expires_at_unix_ms: expires },
          }),
        );
        return;
      }
      if (req.headers["payment-signature"]) {
        const result = {
          ok: true,
          data: {
            order_id: orderId,
            order_number: "TEST-001",
            tx_hash: tx,
            network: "eip155:31337",
            payer,
            amount_atomic: "800000000000000000000",
            is_demo: false,
            fulfillment_status: "ready",
          },
        };
        change(result);
        res.end(JSON.stringify(result));
        return;
      }
      const reservation = "res_" + "a".repeat(32);
      const message = [
        "JPYC EC payment authorization",
        "",
        "I authorize one JPYC payment for this checkout reservation.",
        "Signing this message does not transfer tokens or grant token approval.",
        "",
        "Version: 1",
        `Reservation ID: ${reservation}`,
        "Chain ID: 31337",
        `Payer: ${payer}`,
        `Payee: ${payTo}`,
        "Amount: 800 JPYC",
        "Amount (atomic): 800000000000000000000",
        `Expires at (Unix ms): ${expires}`,
      ].join("\n");
      const required = {
        x402Version: 2,
        resource: { url: merchant.origin + "/api/v1/checkout" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:31337",
            amount: "800000000000000000000",
            asset: token,
            payTo,
            maxTimeoutSeconds: 60,
            extra: {
              assetTransferMethod: "erc20-transfer",
              decimals: 18,
              payerAuthorization: {
                scheme: "personal_sign",
                verifier: "erc1271",
                version: "1",
                message,
              },
            },
          },
        ],
      };
      change(required);
      res.setHeader(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(required)).toString("base64url"),
      );
      res.statusCode = 402;
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "payment_required" },
          data: {
            reservation_id: reservation,
            expires_at_unix_ms: expires,
            summary: {
              subtotal_jpyc: "800",
              discount_jpyc: "0",
              shipping_jpyc: "0",
              checkout_options_surcharge_jpyc: "0",
              total_jpyc: "800",
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    merchant = {
      id: "ec:test",
      name: "Test merchant",
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      shopId: randomUUID(),
      slug: "test",
      payTo,
    };
    client = new JpycEcClient(merchant, 31337, token, true);
  });
  let expires = Date.now() + 600000;
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const input = () => ({
    requestId: randomUUID(),
    payer,
    items: [{ id: product, quantity: 1 }],
    email: "buyer@example.test",
    maxAmount: 800,
  });
  it("reserves, verifies owner challenge, and reports the same settled transfer", async () => {
    const quote = await client.reserve(input());
    expect(quote.amountMinor).toBe(800);
    await client.authorize(quote, "0x" + "ab".repeat(65));
    const settled = await client.settle(quote, payer, tx);
    expect(settled.orderId).toBe(orderId);
    const sent = JSON.parse(
      Buffer.from(received.at(-1).signature, "base64url").toString(),
    );
    expect(sent.payload).toEqual({ payerAddress: payer, txHash: tx });
    expect(sent.accepted).toEqual(quote.accepted);
    expect(settled.fulfillmentStatus).toBe("ready");
  });
  it.each(["payTo", "asset", "network", "amount", "message"])(
    "rejects changed %s before any authorization",
    async (field) => {
      change = (value) => {
        if (!value.accepts) return;
        const a = value.accepts[0];
        if (field === "message")
          a.extra.payerAuthorization.message += "\nExtra instructions";
        else
          a[field] =
            field === "network"
              ? "eip155:137"
              : field === "amount"
                ? "1"
                : payer;
      };
      await expect(client.reserve(input())).rejects.toThrow();
      expect(received.some((r) => r.path.endsWith("/authorize-transfer"))).toBe(
        false,
      );
    },
  );
  it.each(["is_demo", "wallet_address", "checkout_options"])(
    "refuses a merchant change: %s",
    async (field) => {
      change = (v) => {
        if (v.data?.shop)
          v.data.shop[field] =
            field === "is_demo"
              ? true
              : field === "wallet_address"
                ? payer
                : [{ required: true }];
      };
      await expect(client.reserve(input())).rejects.toThrow();
      expect(received).toHaveLength(1);
    },
  );
  it("does not reserve unavailable, fractional, shipping or option-dependent products", async () => {
    for (const modification of [
      { stock: 0 },
      { price_jpyc: "800.1" },
      { requires_shipping: true },
      { variants: { options: [] } },
    ]) {
      received = [];
      change = (v) => {
        if (v.data?.products) Object.assign(v.data.products[0], modification);
      };
      await expect(client.reserve(input())).rejects.toThrow();
      expect(received).toHaveLength(1);
    }
  });
  it("refuses synthetic or unrelated settlement responses", async () => {
    const quote = await client.reserve(input());
    for (const modification of [
      { is_demo: true },
      { tx_hash: "0x" + "55".repeat(32) },
      { amount_atomic: "1" },
      { payer: payTo },
    ]) {
      change = (v) => {
        if (v.data?.order_id) Object.assign(v.data, modification);
      };
      await expect(client.settle(quote, payer, tx)).rejects.toThrow();
    }
  });
  it("requires pinned origins and test-only loopback", () => {
    expect(() => parseMerchants(JSON.stringify([merchant]))).toThrow();
    expect(() =>
      parseMerchants(
        JSON.stringify([{ ...merchant, origin: merchant.origin + "/path" }]),
        true,
      ),
    ).toThrow();
    expect(() =>
      parseMerchants(JSON.stringify([merchant, merchant]), true),
    ).toThrow();
    expect(
      () =>
        new JpycEcClient(
          { ...merchant, origin: "https://example.com" },
          137,
          token,
        ),
    ).toThrow();
    expect(wholeJpy("800.000000000000000000")).toBe(800);
    expect(() => wholeJpy("9007199254740992")).toThrow();
  });
});
