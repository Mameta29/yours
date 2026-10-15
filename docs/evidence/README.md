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
| [cloud-services.json](cloud-services.json) | 公開Cloud Run 5サービス・公開範囲・DB・HSM公開鍵 |
| [public-line-console.json](public-line-console.json) | 最新の公開LINE接続画面・1440px/390px表示・配信assetの一致。ログインや購入は行わない |
| [public-console.json](public-console.json) | 公開画面の実Chrome表示・配備済みasset |
| [public-workspace.json](public-workspace.json) | 新画面の公開配備、全6 asset一致、4画面幅、実Geminiの7商品検索とMarkdown表 |
| [public-owner-permission.json](public-owner-permission.json) | 本人の実MetaMask登録完了報告、API有効化200、公開AmoyのGate/Registry有効状態と上限を照合。購入とは区別 |
| [public-owner-purchase.json](public-owner-purchase.json) | 公開Amoyで本人の300 test JPYC購入。2 RPCでreceipt・Gate・正確なtoken移動を照合。公開Gemini/UCP/AP2/x402、download 200を確認 |
| [public-line-cheap-purchase.json](public-line-cheap-purchase.json) | 実LINEの400 test JPYC購入と未許可店舗への一件承認。実EC注文、在庫1→0、通知、2 RPCの送金照合 |
| [gemini-line-cloud.json](gemini-line-cloud.json) | Google Cloudの実Geminiが最新の公開UCPから在庫のあるHIGH 5kgを選択。注文や送金を伴わない読み取り試験 |
| [workspace-browser.json](workspace-browser.json) | 新画面のMarkdown・状態更新・残高更新・PC/390px表示。ChromeとHTTP fixtureでのUI検証 |
| [gemini-cloud.json](gemini-cloud.json) | Google ADK / Vertex AIによる実カタログ検索 |
| [gemini-ec-cloud.json](gemini-ec-cloud.json) | 公開Geminiが既存ECの2店舗を検索し、実価格・在庫を回答 |
| [gemini-paginated-cloud.json](gemini-paginated-cloud.json) | 公開GeminiがUCP cursorで6件→1件を取得し、実商品7件を回答 |
| [ucp-ec-cloud.json](ucp-ec-cloud.json) | 公開yoursの実ECカタログ、店舗の固定送金先、UCP cursorの照合 |
| [ec-public-catalog.json](ec-public-catalog.json) | 実ECの2店舗・4商品を読み取り。注文・送金なし |
| [ec-rice-restock.json](ec-rice-restock.json) | 本人依頼でCHEAPの通常在庫2件を各20個へ補充。stagingの接続先照合、公開EC・UCPへの反映、実Geminiの全件取得と両店舗比較。注文・送金とは区別 |
| [payment-pipeline.json](payment-pipeline.json) | 74項目。実Anvil・PostgreSQL・AP2 HTTP・外部client・Chrome。外部EC境界はfixture |
| [permissions-api.json](permissions-api.json) | 権限の登録・停止・失効・復旧14項目 |
| [metamask-send-calls-schema.json](metamask-send-calls-schema.json) | MetaMask公式runtime structで旧要求の拒否と修正後の受理を確認。拡張UI・公開取引とは区別 |
| [metamask-7715-compatibility.json](metamask-7715-compatibility.json) | SDKのERC-7715要求と公式MetaMask allowance builder/decoderの照合6項目。拡張UI・公開登録とは区別 |
| [browser-permissions.json](browser-permissions.json) | EIP-7702・ERC-7715登録・中断再開・再接続22項目。raw owner委任を拒否する試験用providerとChrome |

公開AmoyのGate配備は[manifest](../../deployments/amoy.json)で確認する。本人のスマートアカウント設定取引は成功receiptと現在の実装を照合済み。AI権限登録の完了もAPI・公開chainで照合済み。yours Marketの公開300 test JPYC購入も確認済み。実LINEから外部ECのCHEAP購入と一件承認も確認済み。外部AI client単体の公開購入は未確認。
