// Presentation of persisted facts only. A model's prose cannot mark a payment paid.
export function purchaseProgress(run, tasks, intents, audit = []) {
  const task = tasks.find((t) => t.id === run.mandate_id);
  if (!task) return null;
  const intent = intents.find((i) => i.id === task.intent_id);
  const state = intent?.state ?? task.state;
  const hash = intent?.transaction_hash ?? task.transaction_hash;
  const evidence = task.intent_id
    ? audit.filter(
        (e) =>
          e.resource_id === task.intent_id ||
          e.data?.intentId === task.intent_id,
      )
    : [];
  const paid = state === "confirmed" && /^0x[0-9a-f]{64}$/i.test(hash ?? "");
  const stopped = ["failed", "canceled"].includes(state);
  // A runner/network failure says nothing about an already-submitted payment.
  const needsCheck = !intent && ["completed", "failed"].includes(run.status);
  const attention = state === "approval_required";
  const rulesPassed =
    ["authorized", "signing", "submitted", "confirmed"].includes(state) ||
    evidence.some((e) => e.action === "purchase.authorized");
  const received = evidence.some(
    (e) => e.action === "order.digital_access_granted",
  );
  const date = (action) =>
    evidence.find((e) => e.action === action)?.created_at;
  return {
    task,
    intent,
    hash,
    paid,
    received,
    attention,
    stopped,
    needsCheck,
    state,
    amount: intent ? Number(intent.amount_minor) : task.task.max_amount,
    amountIsLimit: !intent,
    title: task.task.items
      .map((i) => i.title + (i.quantity > 1 ? ` × ${i.quantity}` : ""))
      .join("、"),
    steps: [
      {
        label: "依頼を受け付け",
        detail: "本人の購入同意",
        status: "done",
        at: task.created_at,
      },
      {
        label: "会計を作成",
        detail: task.task.merchant_name,
        status: intent
          ? "done"
          : stopped
            ? "stopped"
            : needsCheck
              ? "attention"
              : "current",
        at: intent?.created_at,
      },
      {
        label: "条件を確認",
        detail: attention ? "今回だけの許可が必要" : "予算・店舗・期限",
        status: attention ? "attention" : rulesPassed ? "done" : "waiting",
        at: date("purchase.authorized"),
      },
      {
        label: "支払いを確定",
        detail: paid
          ? "本人のウォレットから"
          : state === "submitted"
            ? "チェーンの確定待ち"
            : stopped
              ? "成立していません"
              : "確定後に反映",
        status: paid
          ? "done"
          : stopped
            ? "stopped"
            : state === "submitted" || state === "signing"
              ? "current"
              : "waiting",
        at: date("transaction.confirmed"),
      },
    ],
  };
}

export const traceLabels = {
  "catalog.search": "カタログを検索",
  "checkout.complete": "UCPで会計を作成",
  "x402.accepted": "x402の支払要求を受理",
  "payment.confirmed": "決済を確認",
  "payment.approval_required": "本人の追加確認へ",
  "payment.failed": "決済が成立せず",
  "payment.canceled": "依頼を取り消し",
};

export const auditLabels = {
  "session.created": "ウォレットでログイン",
  "connection.created": "AIを追加",
  "connection.paused": "AIへの依頼を停止",
  "permission.activated": "購入権限を有効化",
  "permission.revoked_onchain": "購入権限を取り消し",
  "task.consent_requested": "購入内容を本人に確認",
  "task.revoked": "購入依頼を取り消し",
  "agent.started": "Geminiが依頼を受け付け",
  "purchase.authorized": "購入条件を確認",
  "purchase.approval_required": "本人の追加確認が必要",
  "transaction.reserved": "支払取引を準備",
  "transaction.confirmed": "支払いが確定",
  "transaction.reverted": "支払いが成立せず",
  "order.created": "注文を確定",
  "order.digital_access_granted": "購入品の受け取りを開始",
  "order.consent_requested": "今回だけの許可を確認",
  "order.owner_approved": "本人が今回だけの購入を許可",
  "order.endorsed": "今回だけの購入許可を検証",
  "payment.expired": "購入依頼の有効期限切れ",
};
