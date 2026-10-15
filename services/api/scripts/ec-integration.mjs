import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  encodePacked,
  maxUint256,
  toHex,
  parseEther,
  erc20Abi,
  parseEventLogs,
  recoverTypedDataAddress,
} from "viem";
import { encodeDelegations, delegationTypedData } from "@yours/wallet-sdk";
import { importJWK, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { lineConsentData } from '../dist/chat-security.js';
import { claimWork, finishWork } from '@yours/storage';
import { verifyCheckout, validateSchema } from "@yours/ucp";
import { executePayment } from "../../worker/dist/settlement.js";
import { settleEcOrder } from "../../worker/dist/ec-settlement.js";

/** Controlled legacy HTTP boundary. Owner proof and ERC20 receipt are real.
 * This fixture is not evidence of a purchase on the public staging shop. */
export async function startEcFixture({ client, token, payTo }) {
  const productId = randomUUID(),
    shopId = randomUUID(),
    reservations = new Map();
  let merchant,
    loseResponse = true,
    settleCalls = 0, issuerKey;
  const server = createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/api/v1/shops/fixture/products")
        return reply(200, {
          ok: true,
          data: {
            shop: {
              id: shopId,
              slug: "fixture",
              wallet_address: payTo,
              available_chains: [31337],
              is_demo: false,
              x402_enabled: true,
              checkout_options: [],
            },
            products: [
              {
                id: productId,
                name: "External rice",
                description: "Protocol fixture on Anvil",
                price_jpyc: "800",
                stock: 20,
                requires_shipping: false,
                variants: null,
                online_purchase_available: true,
              },
            ],
          },
        });
      if (req.url === "/api/v1/checkout" && !req.headers["payment-signature"]) {
        assert.equal(body.shop_id, shopId);
        assert.equal(body.preferred_chain_id, 31337);
        assert.equal(body.customer_email, "buyer@example.test");
        assert.equal(body.transfer_authorization_version, "1");
        const quantity=body.items?.[0]?.quantity;
        assert.equal(body.items?.length,1);assert.equal(body.items[0].product_id,productId);
        assert.ok(Number.isInteger(quantity)&&quantity>0&&quantity<=20);
        let r = reservations.get(body.idempotency_key);
        if (r) assert.deepEqual(r.request, body);
        else {
          const id = "res_" + randomUUID().replaceAll("-", ""),
            expires = Date.now() + 600000;
          const message = [
            "JPYC EC payment authorization",
            "",
            "I authorize one JPYC payment for this checkout reservation.",
            "Signing this message does not transfer tokens or grant token approval.",
            "",
            "Version: 1",
            `Reservation ID: ${id}`,
            "Chain ID: 31337",
            `Payer: ${body.payer_address}`,
            `Payee: ${payTo.toLowerCase()}`,
            `Amount: ${800*quantity} JPYC`,
            `Amount (atomic): ${parseEther(String(800*quantity))}`,
            `Expires at (Unix ms): ${expires}`,
          ].join("\n");
          const accepted = {
            scheme: "exact",
            network: "eip155:31337",
            asset: token,
            payTo,
            amount: parseEther(String(800*quantity)).toString(),
            maxTimeoutSeconds: 60,
            extra: {
              assetTransferMethod: "erc20-transfer",
              name: "JPY Coin",
              version: "1",
              symbol: "JPYC",
              decimals: 18,
              payerAuthorization: {
                scheme: "personal_sign",
                verifier: "erc1271",
                version: "1",
                message,
              },
            },
          };
          r = { id, expires, accepted, message, request: body };
          reservations.set(body.idempotency_key, r);
        }
        return reply(
          402,
          {
            ok: false,
            error: { code: "payment_required" },
            data: {
              reservation_id: r.id,
              expires_at_unix_ms: r.expires,
              summary: {
                subtotal_jpyc: String(800*quantity),
                discount_jpyc: "0",
                shipping_jpyc: "0",
                checkout_options_surcharge_jpyc: "0",
                total_jpyc: String(800*quantity),
              },
            },
          },
          {
            "PAYMENT-REQUIRED": Buffer.from(
              JSON.stringify({
                x402Version: 2,
                resource: { url: merchant.origin + "/api/v1/checkout" },
                accepts: [r.accepted],
              }),
            ).toString("base64url"),
          },
        );
      }
      const r = [...reservations.values()].find(
        (r) => r.id === body.reservation_id,
      );
      if (!r) return reply(404, { ok: false });
      if (req.url === "/api/v1/checkout/authorize-transfer") {
        let valid;
        if (body.delegation_proof) {
          assert.ok(issuerKey);
          const {payload,protectedHeader}=await jwtVerify(body.delegation_proof,await importJWK(issuerKey,'ES256'),{algorithms:['ES256'],audience:merchant.origin+'/api/v1/checkout/authorize-transfer'});
          assert.equal(protectedHeader.typ,'yours-ec-delegation+jwt');
          assert.equal(payload.reservation_id,r.id);assert.equal(payload.sub,r.request.payer_address);
          assert.equal(payload.message_sha256,createHash('sha256').update(r.message).digest('hex'));
          const recovered=await recoverTypedDataAddress({...lineConsentData(payload.consent,payload.chain_id,payload.gate),signature:payload.owner_signature});
          valid=recovered.toLowerCase()===r.request.payer_address;
        } else valid = await client.verifyMessage({
          address: r.request.payer_address,
          message: r.message,
          signature: body.signature,
        });
        if (!valid) return reply(401, { ok: false });
        r.authorized = true;
        return reply(200, {
          ok: true,
          data: { authorized: true, expires_at_unix_ms: r.expires },
        });
      }
      if (req.url === "/api/v1/checkout" && req.headers["payment-signature"]) {
        settleCalls++;
        assert.equal(r.authorized, true);
        const payload = JSON.parse(
          Buffer.from(req.headers["payment-signature"], "base64url").toString(),
        );
        assert.deepEqual(payload.accepted, r.accepted);
        assert.equal(payload.payload.payerAddress, r.request.payer_address);
        const receipt = await client.getTransactionReceipt({
          hash: payload.payload.txHash,
        });
        assert.equal(receipt.status, "success");
        const events = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: receipt.logs.filter(
            (l) => l.address.toLowerCase() === token.toLowerCase(),
          ),
        });
        assert.equal(
          events.filter(
            (e) =>
              e.args.from.toLowerCase() === r.request.payer_address &&
              e.args.to.toLowerCase() === payTo.toLowerCase() &&
              e.args.value === BigInt(r.accepted.amount),
          ).length,
          1,
        );
        if (!r.order)
          r.order = {
            order_id: randomUUID(),
            order_number: "EC-REAL-TRANSFER",
            tx_hash: receipt.transactionHash,
            network: "eip155:31337",
            payer: r.request.payer_address,
            amount_atomic: r.accepted.amount,
            is_demo: false,
            fulfillment_status: "ready",
          };
        assert.equal(r.order.tx_hash, receipt.transactionHash);
        if (loseResponse) {
          loseResponse = false;
          res.destroy();
          return;
        }
        return reply(200, { ok: true, data: r.order });
      }
      reply(404, { ok: false });
    } catch {
      reply(422, { ok: false, error: { code: "fixture_binding_rejected" } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  merchant = {
    id: "ec:fixture",
    name: "External EC fixture",
    origin: "http://127.0.0.1:" + server.address().port,
    shopId,
    slug: "fixture",
    payTo,
  };
  return {
    merchant,
    productId,
    reservations,
    setIssuer(key) { issuerKey = key; },
    get settleCalls() {
      return settleCalls;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function ecIntegration({
  db,
  request,
  send,
  client,
  owner,
  manifest,
  runtime,
  connection,
  signer,
  fixture,
  passed,
}) {
  const before = (await request("/api/owner/me")).json,
    merchant = fixture.merchant;
  const { json: draft } = await request(
    `/api/owner/permissions/connections/${connection.id}/prepare`,
    {
      perOrder: 2000,
      perPeriod: 5000,
      globalPerOrder: 3000,
      globalPerPeriod: 5000,
      days: 7,
      merchants: ["yours-lab", merchant.id],
    },
    { status: 201 },
  );
  const e = draft.expectation;
  const parent = {
    delegate: runtime.signers.agent.address,
    delegator: owner.address,
    authority: toHex(maxUint256, { size: 32 }),
    salt: toHex(23n),
    signature: "0x",
    caveats: [
      {
        enforcer: manifest.enforcers.periodic,
        terms: encodePacked(
          ["address", "uint256", "uint256", "uint256"],
          [manifest.jpyc, maxUint256, maxUint256, BigInt(e.startTime)],
        ),
        args: "0x",
      },
      {
        enforcer: manifest.enforcers.redeemer,
        terms: manifest.gate,
        args: "0x",
      },
      {
        enforcer: manifest.enforcers.timestamp,
        terms: encodePacked(["uint128", "uint128"], [0n, BigInt(e.expiry)]),
        args: "0x",
      },
      {
        enforcer: manifest.enforcers.value,
        terms: toHex(0n, { size: 32 }),
        args: "0x",
      },
      {
        enforcer: manifest.enforcers.nonce,
        terms: toHex(0n, { size: 32 }),
        args: "0x",
      },
    ],
  };
  parent.signature = await owner.signTypedData(
    delegationTypedData(31337, manifest.manager, parent),
  );
  const base = "/api/owner/permissions/drafts/" + draft.id;
  const terms = (
    await request(base + "/parents", { context: encodeDelegations([parent]) })
  ).json.typedData;
  const calls = (
    await request(base + "/transactions", {
      policy: await owner.signTypedData(terms.policy),
      permission: await owner.signTypedData(terms.permission),
    })
  ).json.calls;
  const policy = await send(calls[0]),
    permission = await send(calls[1]);
  await client.request({ method: "anvil_mine", params: ["0x5"] });
  await request(base + "/activate", { policy, permission });
  assert.equal(
    (await request("/api/owner/me")).json.usage.accountSpent,
    before.usage.accountSpent,
  );
  const products = (
    await request(
      "/ucp/catalog/search",
      { query: "External rice" },
      { asAgent: true },
    )
  ).json.products;
  assert.equal(products.length, 1);
  assert.equal(products[0].metadata.merchant_id, merchant.id);
  const body = {
    requestId: randomUUID(),
    connectionId: connection.id,
    merchantId: merchant.id,
    items: [{ id: merchant.id + "/" + fixture.productId, quantity: 1 }],
    maxAmount: 800,
    minutes: 60,
    email: "buyer@example.test",
  };
  const reservationCount=fixture.reservations.size;
  const drafts = await Promise.all([
    request("/api/owner/tasks/prepare", body, { status: 201 }),
    request("/api/owner/tasks/prepare", body, { status: 201 }),
  ]);
  const task = drafts[0].json;
  assert.deepEqual(drafts[1].json, task);
  assert.equal(fixture.reservations.size, reservationCount+1);
  await request(
    "/api/owner/tasks/prepare",
    { ...body, email: "different@example.test" },
    { status: 409 },
  );
  const signature = await owner.signTypedData(task.typedData);
  await request(
    "/api/owner/tasks/" + task.id + "/approve",
    { signature },
    { status: 422 },
  );
  await request(
    "/api/owner/tasks/" + task.id + "/approve",
    {
      signature,
      transferSignature: await runtime.signers.agent.signMessage({
        message: task.transferAuthorization.message,
      }),
    },
    { status: 409 },
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM mandates WHERE consent_id=$1",
        [task.id],
      )
    ).rows[0].n,
    0,
  );
  const transferSignature = await owner.signMessage({
    message: task.transferAuthorization.message,
  });
  const mandate = (
    await request("/api/owner/tasks/" + task.id + "/approve", {
      signature,
      transferSignature,
    })
  ).json;
  assert.equal(
    (await request("/api/owner/tasks/prepare", body, { status: 201 })).json
      .authorizedMandateId,
    mandate.id,
  );
  const visible = (
    await request("/api/agent/tasks", undefined, { asAgent: true })
  ).json.tasks.find((t) => t.id === mandate.id);
  assert.equal(JSON.stringify(visible).includes(body.email), false);
  assert.equal(visible.task.checkout_id, task.task.checkout_id);
  assert.equal(visible.checkout_profile,runtime.origin+"/.well-known/ucp");
  const checkout = (
    await request(
      "/ucp/checkout-sessions/" + task.task.checkout_id,
      undefined,
      { asAgent: true },
    )
  ).json;
  await verifyCheckout(checkout, [signer.publicJwk]);
  assert.equal(
    checkout.yours.pay_to.toLowerCase(),
    merchant.payTo.toLowerCase(),
  );
  await request(
    "/ucp/checkout-sessions/" + checkout.id,
    { line_items: [{ item: { id: body.items[0].id }, quantity: 2 }] },
    {
      asAgent: true,
      status: 409,
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID(), "If-Match": '"2"' },
    },
  );
  const presentation = (
    await request(
      "/api/agent/present",
      { mandateId: mandate.id, checkoutId: checkout.id },
      { asAgent: true },
    )
  ).json;
  const complete = {
    payment: {
      instruments: [
        {
          id: presentation.instrumentId,
          handler_id: "yours-stablecoin",
          type: "stablecoin",
          selected: true,
          credential: { type: "yours_ap2", mandate_id: mandate.id },
        },
      ],
    },
    ap2: presentation.mandates,
  };
  const pending = (
      await request(
        "/ucp/checkout-sessions/" + checkout.id + "/complete",
        complete,
        {
          asAgent: true,
          status: 202,
          headers: { "Idempotency-Key": randomUUID(), "If-Match": '"2"' },
        },
      )
    ).json,
    id = pending.yours.intent_id;
  const ecRuntime = { ...runtime, ecMerchants: [merchant] };
  await assert.rejects(
    executePayment(db, id, {
      ...ecRuntime,
      ecMerchants: [{ ...merchant, payTo: runtime.payTo }],
    }),
    /ec_reservation_binding_mismatch/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  const oldBalance = await client.readContract({
    address: manifest.jpyc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [merchant.payTo],
  });
  assert.equal(
    (await executePayment(db, id, ecRuntime)).state,
    "payment_required",
  );
  const payload = (
    await request("/api/agent/payments/" + id + "/authorization", undefined, {
      asAgent: true,
    })
  ).json.paymentPayload;
  await request(
    "/api/agent/payments/" + id,
    {},
    {
      asAgent: true,
      status: 202,
      headers: {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString(
          "base64",
        ),
      },
    },
  );
  assert.equal((await executePayment(db, id, ecRuntime)).state, "submitted");
  await client.request({ method: "anvil_mine", params: ["0x5"] });
  assert.equal((await executePayment(db, id, ecRuntime)).state, "confirmed");
  assert.equal(
    (await client.readContract({
      address: manifest.jpyc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [merchant.payTo],
    })) - oldBalance,
    parseEther("800"),
  );
  const options = {
    merchants: [merchant],
    chainId: 31337,
    token: manifest.jpyc,
    test: true,
  };
  assert.equal(
    (await request("/api/owner/purchases/" + id)).json.merchantOrder.status,
    "pending",
  );
  await assert.rejects(settleEcOrder(db, id, options));
  const result = await settleEcOrder(db, id, options);
  assert.deepEqual(await settleEcOrder(db, id, options), result);
  assert.equal(fixture.settleCalls, 2);
  const detail = (await request("/api/owner/purchases/" + id)).json;
  assert.equal(detail.merchantOrder.status, "accepted");
  assert.equal(detail.merchantOrder.order_id, result.orderId);
  assert.equal(detail.deliveryKind, "merchant");
  assert.equal(detail.order.line_items[0].status, "processing");
  assert.equal(detail.order.fulfillment.events.length, 0);
  validateSchema("shopping/order.json", detail.order);
  // Both the chain-confirmed order and the EC-accepted update are real signed
  // webhook deliveries. The receiver must accept enrolled external merchants.
  let delivered = 0;
  for (let work; (work = await claimWork(db, ['order.webhook'], 60, id)); ) {
    const body = { workId: work.id, leaseToken: work.lease_token };
    assert.equal((await request('/internal/webhooks/deliver', body)).json.delivered, true);
    assert.equal((await request('/internal/webhooks/deliver', body)).json.delivered, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM webhook_inbox WHERE event_id=$1', [work.payload.eventId])).rows[0].n, 1);
    await finishWork(db, work); delivered++;
  }
  assert.equal(delivered, 2);
  await request("/api/owner/purchases/" + id + "/download", undefined, {
    status: 409,
  });
  assert.equal(
    (await request("/api/owner/me")).json.usage.accountSpent,
    (BigInt(before.usage.accountSpent) + parseEther("800")).toString(),
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='ec.order.accepted' AND data->>'intentId'=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  passed.push(
    "external merchant added without resetting shared spending",
    "external catalog has pinned merchant and namespaced products",
    "concurrent EC preparation returns one reservation and checkout",
    "external owner consent is required before AP2 issuance",
    "email is excluded from agent tasks",
    "external checkout cannot be edited after reservation",
    "changed external payee is rejected before signing",
    "real 800 JPYC transfer to the separate external payee",
    "lost EC settlement response retries the same transaction and order",
    "EC acceptance does not falsely mark products delivered",
    "signed external EC order notifications are accepted and duplicates persist once",
    "local and external merchants share the same onchain budget",
  );
  return detail.order.id;
}
