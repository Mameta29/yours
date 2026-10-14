# 実装の継続記録

更新: 2026-10-14。repo: https://github.com/Mameta29/yours

## 確定した方向

製品名はyours。UCP対応の委任決済API/SDKを中心に、本人向けAI権限管理画面を提供する。既存ECは接続先、Geminiは最初の購入agent。Google Cloudで動作させ、実署名・実決済・障害復旧まで検証する。小さなcommitを積み重ねる。

## 実装順序

- [x] 独立repoの準備、Google Cloudハッカソン要項の再確認。
- [x] EC非依存SDK・Gate・既存試験の抽出。
- [ ] 複数AIの権限・共有予算・停止・例外同意。
- [ ] PostgreSQLの永続状態・認証・API/SDK。
- [ ] UCP discovery/catalog/cart/checkout/orderとEC adapter。
- [ ] AP2実署名・制約・receiptとstablecoin handler。
- [ ] x402実行・journal・KMS署名・chain照合。
- [ ] Gemini ADKと外部agent接続。
- [ ] 管理画面・wallet承認・本人確認。
- [ ] Google Cloud構成、相互運用・障害試験、README・試用資料。

## 外部設定

Google Cloudの配備先はユーザー指定の `yours-511602`、regionは`asia-northeast1`。課金の関連付けはユーザーが完了。すべてのcloud操作でprojectを明示し、既存CLI設定の別projectには配備しない。

`infra/bootstrap.sh`を実行済み。必要なAPI、Artifact Registry、サービス別アカウント、署名用途別のCloud KMS HSM鍵を作成。Cloud SQL `yours-db`（PostgreSQL 16）、専用DB利用者・Secret Managerを作成し、ユーザー承認済みの`infra/IAM.md`の権限を適用。`yours-migrate-9ngl8`でruntime DB利用者の管理者membership・CREATEDB・CREATEROLEを除去し、4項目ともfalseを実DBで検証。`yours-migrate-rrm4g`でmigration 001〜007と実際に配布するデジタル商品のcatalogを反映。

Polygon Amoyにyours専用Gate `0x42eec579df8fb1f87ae3bddbb90c6a4a9f790504` とRegistry `0xa5524081a219422ee5247afDEda40791E953eF2B`を配備。Cloud HSM relayerの実署名を使用し、5 confirmationsとblock hashを検証。txは`0x7ffe2572d92c1b32b33ec16cead5156b1a9c7ec2a0381f9e5bc5048a121664b9`。公開情報・code hashは`deployments/amoy.json`。これは配備の証拠であり、公開Amoyでの購入成功はまだ確認していない。

## 変更と確認

初期状態は空repo。親ECの未コミット作業と他worktreeを保持し、独立cloneで作業する。抽出元のrevisionとファイル一覧はEXTRACTION.jsonに保存した。

- SDK: 型付きowner同意、委任検証、生成ABI。buildと58テスト通過。EIP-5792によるアプリからのスマートアカウント設定と、batch IDによる再開を追加。
- 権限API: 本人署名・公式MetaMask委任・5 confirmations後の有効化・即時pause・onchain revokeを実装。実PostgreSQL/Anvilで14項目通過（`docs/evidence/permissions-api.json`）。中断した登録のhashを保持し、確定済みpolicyの期間を保ったまま2件目だけ新しい本人署名で再開。実Chromeと試験用EIP-1193 providerによる7項目も通過（`docs/evidence/browser-permissions.json`）。実MetaMask拡張は別途確認する。
- Solidity: AI接続別の権限と共有予算を同一transactionで強制。36テスト（fuzzを含む）通過、EIP-170サイズ制限内。公式MetaMask DelegationManager・EIP-7702とのローカル統合12件通過（`docs/evidence/local-chain.json`）。公開Amoy配備済み。
- Domain: 単位の厳密変換、期限・共有予算・AI別予算をfail-closedで判定。7テスト通過。
- PostgreSQL: owner署名認証、idempotency、outbox、予算予約、署名済みtransactionを送信前に保存するjournal。実PostgreSQLで6件の同時実行・復旧試験通過。
- UCP: stable 2026-08-25のschemaを固定。discovery、商品検索、cart、配送・署名付きcheckout、在庫予約、AP2付きcomplete、決済後のorder、HTTP署名、webhookを実装。UCPパッケージ12件・API16件のテスト通過。外部EC adapterは未実装。
- KMS: 非export鍵のEVM/P-256署名adapter、CRC・署名復元検証。ローカル暗号試験2件通過。Cloud HSMの実EVM/P-256署名を検証済み（`docs/evidence/cloud-kms.json`）。
- AP2: 固定した公式v0.2 SDKでopen→closed mandate、制約・署名検証、receiptを実装。実署名・公式SDK・本人の新しいEIP-712同意とprivate issuerの18件通過。Cloud Run配備と、mandateの一回消費・実決済receiptへの束縛を実装済み。上流仕様との差異は`docs/design/INTEROPERABILITY.md`。

`PAYMENT_PIPELINE=1 node packages/wallet-sdk/scripts/local-integration.mjs`で、本人署名→AP2 private HTTP→UCP complete→x402 HTTP 402/支払署名→実ERC-7710送金→order/署名付きreceiptの24項目を検証。送信応答消失から同一hashで復旧、金額改変拒否、期間超過の本人一件同意も含む。証拠は`docs/evidence/payment-pipeline.json`。これはAnvilと試験tokenでの結合検証。

## 公開環境での確認

[管理画面/API](https://yours-api-110852561536.asia-northeast1.run.app)を公開。mandates・worker・agentは非公開のCloud Run。現在のimage tagは`onboarding-20261014`、Cloud Buildは`42c5e08f-6d2c-4fcc-a002-981f948ecd2a`、sourceは`4885f81`。migration job `yours-migrate-6tlq9`で001〜009を反映。API revisionは`yours-api-00004-6v9`。Cloud SQL接続、HSM公開鍵とdiscoveryの一致、4サービスのhealthと公開範囲を確認（[証拠](evidence/cloud-services.json)）。後続commitは再配備するまで公開環境の成果に含めない。

Google ADK → Vertex AI `gemini-3.8-flash` → 実Cloud SQL catalogの検索が公開画面のAPI経由で成功（[証拠](evidence/gemini-cloud.json)）。未接続の試用は検索専用で、決済権限を持たない。購入は本人署名・AP2・x402を経由する。

管理画面は1440pxと390pxで実ブラウザ検証済み（[公開検証](evidence/public-console.json)）。接続、AI別権限、共有予算、停止、注文専用同意、購入品downloadを実APIへ接続。未設定EOAから「ウォレットで承認する」を押すとMetaMaskの設定確認を開始する。画像で報告された`wallet_upgrade_required`の原因を修正し、設定取引の応答消失・reload・部分登録復旧を含むローカルChromeの10項目を確認（[設計](design/WALLET-ONBOARDING.md)）。公開Amoyで実MetaMaskの設定・本人購入はユーザーに再確認を依頼中。

UCP RFC 9421署名、API keyとplatform profileの結び付け、DNSを固定したprofile取得、order webhookのoutbox・inbox・重複排除・非同期auditを実装・配備。非公開workerへの1分間隔のScheduler `yours-outbox`を設定済み。

外部AIのP-256 AP2 holderとEVM agentを分離して実装・配備。注文専用leafとintentを外部AI自身が署名し、yours側は署名の検証とrelayを行う。公式AP2 SDKによる外部holderの提示、実ERC-7710送金、別AIを追加しても共有消費が維持されること、共有予算超過で送信前に止まることを含む44項目のローカル結合検証が成功。外部AI向けclient例、購入するAIの選択、本人だけができるtoken再発行を追加。client単体の公開決済は未確認。

## 次に完了する事項

- 公開Amoyで本人の資産から実購入、外部AI client単体の実行確認。
- 外部EC adapter、注文詳細・digital fulfillment・返金の照合。
- 提出用README・構成図・試用手順を追加中。GitHub CI、実処理の動画、Dashboard提出の状態を別途記録。

ローカルの最新結合証拠は[決済pipeline](evidence/payment-pipeline.json)。API/SDK、Anvil、公開Google Cloud、公開Amoyの証拠はそれぞれ区別する。
