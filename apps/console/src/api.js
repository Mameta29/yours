export async function api(path, body, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(body === undefined
      ? {}
      : { method: options.method ?? "POST", body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? "request_failed");
    error.status = response.status;
    throw error;
  }
  return data;
}
const messages = {
  demo_rate_limit: "公開試用の上限に達しました。ウォレットでログインするか、時間をおいてお試しください。",
  unauthorized: "ウォレットでログインしてください。",
  wallet_account_changed:
    "ウォレットのアカウントが変わりました。もう一度接続してください。",
  wallet_chain_mismatch: "Polygon Amoyへ切り替えてください。",
  wallet_permission_unsupported:
    "このウォレットではAmoyの委任権限に対応していません。対応するMetaMask拡張、または設定済みのスマートアカウントを使ってください。",
  wallet_upgrade_required: "このウォレットのスマートアカウント設定が必要です。",
  agent_already_connected:
    "このAIは登録済みです。カードから権限を設定できます。",
  order_proof_preparing:
    "注文の証拠を準備中です。少し待って再度お試しください。",
  order_expiring:
    "この注文の承認期限が近づいています。新しい購入依頼を作成してください。",
  permission_inactive: "先にAIの権限を設定してください。",
  permission_expiring: "AIの権限を更新してください。",
  agent_rate_limit: "今しばらく待ってから、もう一度お試しください。",
  authority_service_rejected:
    "同意を確認できませんでした。注文と権限の状態をご確認ください。",
  gemini_not_configured: "Geminiとの接続を準備中です。",
  payments_not_configured: "決済の接続を準備中です。",
  existing_grant_expires_earlier:
    "他のAIの委任期限を確認してから更新してください。",
};
export function explain(error) {
  if (error?.code === 4001 || /user rejected|user denied|request rejected by user/i.test(error?.message ?? ""))
    return "ウォレットでの操作をキャンセルしました。";
  return (
    messages[error?.message] ??
    "処理を完了できませんでした。状態を確認してから、再度お試しください。"
  );
}
export const short = (value) =>
  value ? value.slice(0, 6) + "…" + value.slice(-4) : "";
export const yen = (value) =>
  new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(
    value ?? 0,
  );
export const fromAtomic = (value) => Number(BigInt(value ?? 0) / 10n ** 18n);
