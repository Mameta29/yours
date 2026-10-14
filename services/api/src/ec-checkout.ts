import { randomBytes, randomUUID } from "node:crypto";
import { keccak256, stringToHex, type Address } from "viem";
import { DomainError, digest } from "@yours/domain";
import { transaction, audit, type Db, type Tx } from "@yours/storage";
import { consentDomain, taskConsentTypes } from "@yours/wallet-sdk";
import { profile, negotiate, authorizeCheckout } from "@yours/ucp";
import type { P256Signer } from "@yours/signing";
import type { EcQuote } from "@yours/jpyc-ec";
import type { Actor } from "./auth.js";
import type { Config } from "./config.js";
import { ecMerchants, ecClient } from "./merchants.js";
import { makeDocument } from "./merchant.js";

type Owner = Extract<Actor, { kind: "owner" }>;
type Request = {
  connectionId: string;
  merchantId: string;
  items: { id: string; quantity: number }[];
  maxAmount: number;
  minutes: number;
  requestId?: string;
  email?: string;
};
async function permission(
  db: Pick<Db, "query"> | Tx,
  actor: Owner,
  connectionId: string,
) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT c.*,p.document AS permission,p.status AS permission_status,g.document AS policy FROM connections c JOIN permissions p ON p.connection_id=c.id JOIN policies g ON g.account_id=c.account_id WHERE c.id=$1 AND c.account_id=$2`,
    [connectionId, actor.accountId],
  );
  if (
    !row ||
    row.status !== "active" ||
    row.permission_status !== "active" ||
    row.policy.status !== "active"
  )
    throw new DomainError("permission_inactive", 403);
  if (
    Math.min(row.permission.validUntil, row.policy.validUntil) <=
    Date.now() / 1000 + 120
  )
    throw new DomainError("permission_expiring", 409);
  return row;
}
async function prepared(tx: Tx, row: any, actor: Owner, config: Config) {
  const {
    rows: [consent],
  } = await tx.query("SELECT * FROM task_consents WHERE id=$1 FOR UPDATE", [
    row.consent_id,
  ]);
  const {
    rows: [mandate],
  } = await tx.query("SELECT id FROM mandates WHERE consent_id=$1", [
    row.consent_id,
  ]);
  const now = Math.floor(Date.now() / 1000);
  if (!mandate) {
    if (
      consent.task.expires_at <= now + 120 ||
      row.quote.expiresAt <= Date.now() + 120000
    )
      throw new DomainError("ec_quote_expired", 409);
    if (consent.valid_until <= now) {
      consent.nonce = "0x" + randomBytes(32).toString("hex");
      consent.valid_until = Math.min(now + 300, consent.task.expires_at);
      await tx.query(
        "UPDATE task_consents SET nonce=$2,valid_until=$3 WHERE id=$1",
        [consent.id, consent.nonce, consent.valid_until],
      );
    }
  }
  return {
    id: consent.id,
    task: consent.task,
    ...(mandate ? { authorizedMandateId: mandate.id } : {}),
    transferAuthorization: {
      message: row.quote.message,
      reservationId: row.quote.reservationId,
      authorized: Boolean(row.authorized_at),
    },
    typedData: {
      domain: consentDomain(config.CHAIN_ID, config.GATE_ADDRESS as Address),
      types: { TaskConsent: taskConsentTypes.TaskConsent },
      primaryType: "TaskConsent",
      message: {
        account: actor.address,
        connectionId: keccak256(stringToHex(row.connection_id)),
        taskHash: "0x" + consent.task_hash,
        nonce: consent.nonce,
        validUntil: String(consent.valid_until),
      },
    },
  };
}
export async function prepareEcCheckout(
  db: Db,
  config: Config,
  signer: P256Signer,
  actor: Owner,
  request: Request,
) {
  const merchant = ecMerchants(config).find((m) => m.id === request.merchantId);
  if (!merchant || !request.requestId || !request.email)
    throw new DomainError("ec_buyer_details_required", 422);
  const requestHash = digest(request),
    id = request.requestId;
  const existing = await transaction(db, async (tx) => {
    await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      actor.accountId,
    ]);
    await permission(tx, actor, request.connectionId);
    await tx.query(
      "INSERT INTO ec_reservations(id,account_id,connection_id,merchant_id,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
      [id, actor.accountId, request.connectionId, merchant.id, requestHash],
    );
    const {
      rows: [row],
    } = await tx.query(
      "SELECT * FROM ec_reservations WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [id, actor.accountId],
    );
    if (!row || row.request_hash !== requestHash)
      throw new DomainError("idempotency_conflict", 409);
    return row.consent_id ? await prepared(tx, row, actor, config) : null;
  });
  if (existing) return existing;
  const prefix = merchant.id + "/";
  const items = request.items.map((i) => {
    if (!i.id.startsWith(prefix))
      throw new DomainError("ec_product_mismatch", 422);
    return { id: i.id.slice(prefix.length), quantity: i.quantity };
  });
  // Network work happens outside SQL transactions. The remote reservation key
  // is persisted first, so a lost response can only retry this same reservation.
  const quote = await ecClient(config, merchant).reserve({
    requestId: id,
    payer: actor.address,
    items,
    email: request.email,
    maxAmount: request.maxAmount,
  });
  return transaction(db, async (tx) => {
    await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      actor.accountId,
    ]);
    const connection = await permission(tx, actor, request.connectionId);
    const {
      rows: [row],
    } = await tx.query(
      "SELECT * FROM ec_reservations WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [id, actor.accountId],
    );
    if (row.consent_id) return prepared(tx, row, actor, config);
    const now = Math.floor(Date.now() / 1000),
      expires = Math.min(
        now + request.minutes * 60,
        connection.permission.validUntil,
        connection.policy.validUntil,
        Math.floor(quote.expiresAt / 1000) - 30,
      );
    if (expires <= now + 120) throw new DomainError("ec_quote_expiring", 409);
    const checkoutId = randomUUID(),
      consentId = randomUUID(),
      products = quote.items.map((i) => ({ ...i, id: prefix + i.id }));
    const priced = {
      subtotal: quote.amountMinor,
      shipping: false,
      lines: products.map((i, index) => ({
        id: "line-" + (index + 1),
        item: { id: i.id, title: i.title, price: i.price },
        quantity: i.quantity,
        totals: [
          { type: "subtotal", amount: i.price * i.quantity },
          { type: "total", amount: i.price * i.quantity },
        ],
      })),
    };
    const p = profile(config.PUBLIC_ORIGIN, "platform", [signer.publicJwk]);
    const document = await makeDocument(
      checkoutId,
      "checkout",
      {},
      priced,
      1,
      new Date(expires * 1000),
      negotiate(p, p),
      {
        ...config,
        MERCHANT_ID: merchant.id,
        MERCHANT_NAME: merchant.name,
        MERCHANT_PAY_TO: merchant.payTo,
      },
      signer,
    );
    document.status = "incomplete";
    document.yours.ec = {
      reservation_id: quote.reservationId,
      requirements_hash: quote.requirementsHash,
    };
    document.messages = [
      {
        type: "error",
        code: "owner_authorization_required",
        content: "この予約に対する本人の同意が必要です。",
        severity: "requires_buyer_input",
      },
    ];
    delete document.ap2;
    document.ap2 = {
      merchant_authorization: await authorizeCheckout(document, signer),
    };
    await tx.query(
      `INSERT INTO merchant_sessions(id,merchant_id,kind,actor,platform_profile,ap2_required,status,document,expires_at) VALUES($1,$2,'checkout',$3,$4,true,'incomplete',$5,to_timestamp($6))`,
      [
        checkoutId,
        merchant.id,
        "agent:" + connection.id,
        connection.platform_profile ??
          config.PUBLIC_ORIGIN + "/.well-known/ucp",
        JSON.stringify(document),
        expires,
      ],
    );
    const task = {
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      currency: "JPY",
      max_amount: quote.amountMinor,
      items: products.map(({ id, title, quantity }) => ({
        id,
        title,
        quantity,
      })),
      instrument_id: `yours:${config.CHAIN_ID}:${actor.address}:${connection.id}`,
      expires_at: expires,
      checkout_id: checkoutId,
      requirements_hash: quote.requirementsHash,
    };
    const nonce = "0x" + randomBytes(32).toString("hex");
    await tx.query(
      "INSERT INTO task_consents(id,account_id,connection_id,task,task_hash,nonce,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        consentId,
        actor.accountId,
        connection.id,
        JSON.stringify(task),
        digest(task),
        nonce,
        Math.min(now + 300, expires),
      ],
    );
    await tx.query(
      "UPDATE ec_reservations SET consent_id=$2,checkout_id=$3,quote=$4 WHERE id=$1",
      [id, consentId, checkoutId, JSON.stringify(quote)],
    );
    await audit(
      tx,
      actor.accountId,
      "owner:" + actor.accountId,
      "ec.reservation.created",
      id,
      { checkoutId, merchantId: merchant.id, amount: quote.amountMinor },
    );
    return prepared(
      tx,
      { ...row, consent_id: consentId, checkout_id: checkoutId, quote },
      actor,
      config,
    );
  });
}
export async function authorizeEcCheckout(
  db: Db,
  config: Config,
  signer: P256Signer,
  actor: Owner,
  consentId: string,
  signature?: string,
) {
  const {
    rows: [row],
  } = await db.query(
    "SELECT * FROM ec_reservations WHERE consent_id=$1 AND account_id=$2",
    [consentId, actor.accountId],
  );
  if (!row) return;
  if (row.authorized_at) return;
  if (!signature) throw new DomainError("ec_owner_authorization_required", 422);
  const merchant = ecMerchants(config).find((m) => m.id === row.merchant_id);
  if (!merchant) throw new DomainError("merchant_not_enrolled", 422);
  await permission(db, actor, row.connection_id);
  await ecClient(config, merchant).authorize(row.quote as EcQuote, signature);
  await transaction(db, async (tx) => {
    await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      actor.accountId,
    ]);
    await permission(tx, actor, row.connection_id);
    const {
      rows: [current],
    } = await tx.query("SELECT * FROM ec_reservations WHERE id=$1 FOR UPDATE", [
      row.id,
    ]);
    if (current.authorized_at) return;
    const {
      rows: [session],
    } = await tx.query(
      "SELECT * FROM merchant_sessions WHERE id=$1 FOR UPDATE",
      [row.checkout_id],
    );
    if (
      session.status !== "incomplete" ||
      session.expires_at.getTime() <= Date.now() + 120000
    )
      throw new DomainError("ec_quote_expired", 409);
    const document = {
      ...session.document,
      status: "ready_for_complete",
      yours: { ...session.document.yours, revision: session.revision + 1 },
    };
    delete document.messages;
    delete document.ap2;
    document.ap2 = {
      merchant_authorization: await authorizeCheckout(document, signer),
    };
    await tx.query(
      "UPDATE merchant_sessions SET status='ready_for_complete',document=$2,revision=revision+1,updated_at=now() WHERE id=$1",
      [session.id, JSON.stringify(document)],
    );
    await tx.query(
      "UPDATE ec_reservations SET authorized_at=now(),signature_hash=$2 WHERE id=$1",
      [row.id, digest(signature)],
    );
    await audit(
      tx,
      actor.accountId,
      "owner:" + actor.accountId,
      "ec.reservation.authorized",
      row.id,
      { checkoutId: session.id },
    );
  });
}
