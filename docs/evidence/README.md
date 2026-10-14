# 再現可能な検証

`local-chain.json`は`YoursPurchaseGate`、MetaMask公式DelegationManager / EIP-7702 account / enforcersを、使い捨てのAnvilへ配備した結果。資産は生成した本人walletに置き、AIへの事前送金は行わない。token、swap router、risk/human署名者はローカル試験用であり、公開Amoyや本人のブラウザwalletでの成功を表すものではない。

```sh
pnpm install --frozen-lockfile
bash scripts/prepare-framework.sh
pnpm --filter @yours/contracts build
pnpm --filter @yours/wallet-sdk build
# 別terminalで実行。公開RPCには接続しない。
anvil --host 127.0.0.1 --port 18812 --chain-id 31337 --hardfork prague --silent
node packages/wallet-sdk/scripts/local-integration.mjs
# PostgreSQL yours_testを用意し、AP2/worker/APIを含めて検証する場合
pnpm --filter @yours/api... --filter @yours/worker... build
PAYMENT_PIPELINE=1 BROWSER_PURCHASE=1 node packages/wallet-sdk/scripts/local-integration.mjs
```

scriptはchain ID・Anvil・loopback URL・framework commitを検証し、生成した秘密鍵は保存も出力もしない。エビデンスには公開アドレス、取引hash、試験範囲だけを保存する。

## 検証の入口

| 証拠 | 範囲 |
| --- | --- |
| [cloud-services.json](cloud-services.json) | 公開Cloud Run 4サービス・公開範囲・DB・HSM公開鍵 |
| [public-console.json](public-console.json) | 公開画面の実Chrome表示・配備済みasset |
| [gemini-cloud.json](gemini-cloud.json) | Google ADK / Vertex AIによる実カタログ検索 |
| [gemini-ec-cloud.json](gemini-ec-cloud.json) | 公開Geminiが既存ECの2店舗を検索し、実価格・在庫を回答 |
| [gemini-paginated-cloud.json](gemini-paginated-cloud.json) | 公開GeminiがUCP cursorで6件→1件を取得し、実商品7件を回答 |
| [ucp-ec-cloud.json](ucp-ec-cloud.json) | 公開yoursの実ECカタログ、店舗の固定送金先、UCP cursorの照合 |
| [ec-public-catalog.json](ec-public-catalog.json) | 実ECの2店舗・4商品を読み取り。注文・送金なし |
| [payment-pipeline.json](payment-pipeline.json) | 68項目。実Anvil・PostgreSQL・AP2 HTTP・外部client・Chrome。外部EC境界はfixture |
| [permissions-api.json](permissions-api.json) | 権限の登録・停止・失効・復旧14項目 |
| [metamask-send-calls-schema.json](metamask-send-calls-schema.json) | MetaMask公式runtime structで旧要求の拒否と修正後の受理を確認。拡張UI・公開取引とは区別 |
| [browser-permissions.json](browser-permissions.json) | EIP-7702登録・中断再開・再接続18項目。Chromeと試験用provider |

公開AmoyのGate配備は[manifest](../../deployments/amoy.json)で確認する。本人の公開購入・実MetaMask拡張での操作は別途確認が必要。
