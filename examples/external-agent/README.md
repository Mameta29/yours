# 自分のAIからyoursを使う

このclientは外部AIサービスへの組み込み例です。本人の秘密鍵を取得せず、外部AI自身のEVM鍵とP-256 AP2鍵を手元で管理します。LLMには署名鍵を渡さず、このclientを権限の限定されたtoolとして呼び出します。

## 接続

repo rootで `pnpm install --frozen-lockfile`、`pnpm build`。Python側は `cd services/mandates && uv sync --frozen` で固定した公式AP2 SDKを用意します。

```sh
pnpm --filter @yours/external-agent-example init
```

`.local/external-agent/keys.json` にこのAI専用の鍵を0600で生成します。既存ファイルは上書きしません。表示された `agentAddress` と `ap2PublicJwk` を、yours画面の「外部のAIサービス」に登録してください。ownerが購入条件を承認すると接続が有効になります。AIアドレスへの入金は不要です。

画面に一度だけ表示されたtokenを `YOURS_AGENT_TOKEN` 環境変数に設定します。tokenも秘密鍵もGitへ追加しないでください。必要なら `YOURS_ORIGIN`、`YOURS_AGENT_KEY_FILE` を明示して切り替えます。標準の配備先・manifestはPolygon Amoyです。

```sh
pnpm --filter @yours/external-agent-example tasks
pnpm --filter @yours/external-agent-example run <本人が承認したtaskのid>
```

`run` は実際のtest JPYC決済を行います。本人のタスクに含まれる商品・数量・上限をチェックし、UCP HTTP署名とmerchant authorizationを検証してから、公式AP2 SDKでclosed mandateを作成します。次に注文・送金先・金額・Gateに束縛したleafとintentを自身の鍵で署名し、x402 `PAYMENT-SIGNATURE` を送ります。

予算超過なら `approval_required` で止まり、本人にyours画面でその注文を確認してもらいます。結果が未確定なら、**同じtask id**で再実行します。ローカルjournalとAPIのidempotencyで同じ購入を再照合し、新しい送金を作り直しません。確定時は実transaction hashとUCP orderが返ります。

公開profileがあるサービスはowner登録APIの `platformProfile` を使い、同じURLを `YOURS_PLATFORM_PROFILE` に指定できます。サーバ側でoperatorがoriginを登録する必要があります。省略時はyoursのplatform identityに束縛したAPI tokenで接続します。任意のURLへtokenを転送したり、未登録originを自動的に許可したりしません。

サーバ側の相互運用検証は[44項目の結合試験](../../docs/evidence/payment-pipeline.json)。公開配備と実MetaMaskでの状況は[実装記録](../../docs/IMPLEMENTATION.md)を参照してください。
