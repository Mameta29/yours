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
  purchase_not_found:
    "このウォレットの注文が見つかりません。購入したアカウントでログインしてください。",
  download_unavailable:
    "購入品の準備を確認できませんでした。時間をおいて再度お試しください。",
  activation_confirming:
    "登録の確定を待っています。しばらくして「登録を再開」から続けてください。",
  permission_draft_expired:
    "署名の有効時間が過ぎました。画面を開き直すと、成功済みの登録から再開できます。",
  permission_stopped_during_activation:
    "この登録の途中で権限が停止されました。画面を開き直して、新しい条件を承認してください。",
  policy_transaction_required:
    "送信済みの登録を確認できませんでした。最初に登録したブラウザで再開してください。",
  demo_rate_limit:
    "公開試用の上限に達しました。ウォレットでログインするか、時間をおいてお試しください。",
  unauthorized: "ウォレットでログインしてください。",
  wallet_account_changed:
    "ウォレットのアカウントが変わりました。もう一度接続してください。",
  wallet_chain_mismatch: "Polygon Amoyへ切り替えてください。",
  wallet_permission_unsupported:
    "このウォレットではAmoyで必要な購入権限と実行先の制限を確認できませんでした。対応するMetaMask拡張でお試しください。",
  wallet_permission_probe_failed:
    "MetaMaskの購入権限への対応を確認できませんでした。「エラーの詳細」で理由を確認できます。",
  wallet_permission_request_failed:
    "MetaMaskで購入権限の承認を続行できませんでした。「エラーの詳細」で理由を確認できます。",
  wallet_permission_invalid_request:
    "MetaMaskが購入権限の要求を受け付けませんでした。「エラーの詳細」を共有してください。",
  wallet_permission_validation_failed:
    "ウォレットが返した購入権限が指定の条件と一致しないため、登録を停止しました。",
  wallet_signature_request_failed:
    "MetaMaskで条件の署名を続行できませんでした。「エラーの詳細」で理由を確認できます。",
  wallet_signature_invalid_request:
    "MetaMaskが条件の署名要求を受け付けませんでした。「エラーの詳細」を共有してください。",
  wallet_signature_unsupported:
    "このウォレットは条件の署名に対応していません。MetaMask拡張でお試しください。",
  wallet_permission_request_required:
    "この委任にはMetaMaskの購入権限の確認が必要です。画面を再読み込みして登録を再開してください。",
  wallet_upgrade_required:
    "ウォレットの設定を確認できませんでした。もう一度登録を進めてください。",
  wallet_rejected: "ウォレットでの操作をキャンセルしました。",
  wallet_permission_pending:
    "MetaMaskに確認待ちの画面があります。そちらで承認またはキャンセルしてください。",
  wallet_upgrade_unsupported:
    "このウォレットはAmoyでのアプリからの設定に対応していません。最新版のMetaMask拡張でお試しください。",
  wallet_implementation_mismatch:
    "このアカウントには別のスマートアカウント設定があります。既存の設定を確認するか、別のアカウントで接続してください。",
  wallet_upgrade_confirming:
    "設定の反映を待っています。時間をおいて同じボタンから再開できます。",
  wallet_upgrade_response_invalid:
    "MetaMaskからの設定取引の応答を確認できませんでした。取引は再送せず、保存済みの状態から確認を再開できます。",
  wallet_upgrade_request_failed:
    "MetaMaskでウォレット設定を続行できませんでした。下の「エラーの詳細」で、停止した処理と理由を確認できます。",
  wallet_permission_missing:
    "MetaMaskが、このサイトによるアカウントへのアクセスを許可していません。ウォレットを接続し直してください。",
  wallet_upgrade_invalid_request:
    "MetaMaskがウォレット設定の要求を受け付けませんでした。「エラーの詳細」を共有してください。",
  wallet_upgrade_batch_unknown:
    "前回の設定取引をMetaMaskで見つけられませんでした。別のブラウザやウォレットで操作していないか確認してください。送信済みの可能性があるため、新しい取引は作成していません。",
  wallet_upgrade_not_applied:
    "取引は完了しましたが、必要なウォレット設定を確認できませんでした。MetaMaskのスマートアカウント設定をご確認ください。",
  wallet_upgrade_failed:
    "ウォレットの設定取引が完了しませんでした。MetaMaskで結果を確認してから、もう一度お試しください。",
  agent_already_connected:
    "このAIは登録済みです。カードから権限を設定できます。",
  order_proof_preparing:
    "注文の証拠を準備中です。少し待って再度お試しください。",
  order_expiring:
    "この注文の承認期限が近づいています。新しい購入依頼を作成してください。",
  ec_price_changed:
    "店舗の価格が変わりました。カタログを読み直して金額を確認してください。",
  ec_product_unavailable:
    "この商品は現在購入できません。店舗の在庫と販売条件をご確認ください。",
  ec_quote_expired:
    "店舗の予約期限が過ぎました。購入画面を閉じ、新しく商品を選んでください。",
  ec_quote_expiring:
    "店舗の予約期限が近づいています。時間をおいて購入画面からやり直してください。",
  ec_owner_authorization_rejected:
    "店舗で本人の署名を確認できませんでした。同じ購入画面から再試行してください。送金は行っていません。",
  ec_merchant_changed: "店舗の支払い設定が変わったため、購入を停止しました。",
  ec_settlement_pending:
    "支払い後の店舗受付を確認中です。同じ取引で確認を続けています。",
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
  if (
    error?.code === 4001 ||
    /user rejected|user denied|request rejected by user/i.test(
      error?.message ?? "",
    )
  )
    return "ウォレットでの操作をキャンセルしました。";
  return (
    messages[error?.message] ??
    "処理を完了できませんでした。状態を確認してから、再度お試しください。"
  );
}
export function walletErrorDetails(error) {
  const d = error?.diagnostic;
  if (
    !d ||
    ![
      "wallet_getCapabilities",
      "wallet_sendCalls",
      "wallet_getCallsStatus",
      "wallet_getSupportedExecutionPermissions",
      "wallet_requestExecutionPermissions",
      "eth_signTypedData_v4",
    ].includes(d.method)
  )
    return undefined;
  return [
    d.method,
    Number.isSafeInteger(d.code) ? `RPC ${d.code}` : "RPC codeなし",
    d.message,
  ]
    .filter(Boolean)
    .join("\n");
}
export const short = (value) =>
  value ? value.slice(0, 6) + "…" + value.slice(-4) : "";
export const yen = (value) =>
  new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(
    value ?? 0,
  );
export const fromAtomic = (value) => Number(BigInt(value ?? 0) / 10n ** 18n);
