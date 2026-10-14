# 実装の継続記録

更新: 2026-10-15。repo: https://github.com/Mameta29/yours

## 確定した方向

製品名はyours。UCP対応の委任決済API/SDKを中心に、本人向けAI権限管理画面を提供する。既存ECは接続先、Geminiは最初の購入agent。Google Cloudで動作させ、実署名・実決済・障害復旧まで検証する。小さなcommitを積み重ねる。

## 実装順序

- [x] 独立repoの準備、Google Cloudハッカソン要項の再確認。
- [x] EC非依存SDK・Gate・既存試験の抽出。
- [x] 複数AIの権限・共有予算・停止・例外同意。
- [x] PostgreSQLの永続状態・認証・API/SDK。
- [x] UCP discovery/catalog/cart/checkout/order。
- [x] 既存EC adapter、Google Cloud配備、実ECカタログの公開確認。
- [ ] 公開Amoyでの本人購入確認。
- [x] AP2実署名・制約・receiptとstablecoin handler。
- [x] x402実行・journal・KMS署名・chain照合。
- [x] Gemini ADKと外部agent接続。
- [x] 管理画面・wallet承認・本人確認。
- [x] Google Cloud構成、相互運用・障害試験、README・試用資料。

## 外部設定

Google Cloudの配備先はユーザー指定の `yours-511602`、regionは`asia-northeast1`。課金の関連付けはユーザーが完了。すべてのcloud操作でprojectを明示し、既存CLI設定の別projectには配備しない。

`infra/bootstrap.sh`を実行済み。必要なAPI、Artifact Registry、サービス別アカウント、署名用途別のCloud KMS HSM鍵を作成。Cloud SQL `yours-db`（PostgreSQL 16）、専用DB利用者・Secret Managerを作成し、ユーザー承認済みの`infra/IAM.md`の権限を適用。`yours-migrate-9ngl8`でruntime DB利用者の管理者membership・CREATEDB・CREATEROLEを除去し、4項目ともfalseを実DBで検証。`yours-migrate-rrm4g`でmigration 001〜007と実際に配布するデジタル商品のcatalogを反映。

Polygon Amoyにyours専用Gate `0x42eec579df8fb1f87ae3bddbb90c6a4a9f790504` とRegistry `0xa5524081a219422ee5247afDEda40791E953eF2B`を配備。Cloud HSM relayerの実署名を使用し、5 confirmationsとblock hashを検証。txは`0x7ffe2572d92c1b32b33ec16cead5156b1a9c7ec2a0381f9e5bc5048a121664b9`。公開情報・code hashは`deployments/amoy.json`。これは配備の証拠であり、公開Amoyでの購入成功はまだ確認していない。

## 変更と確認

初期状態は空repo。親ECの未コミット作業と他worktreeを保持し、独立cloneで作業する。抽出元のrevisionとファイル一覧はEXTRACTION.jsonに保存した。

- SDK: 型付きowner同意、委任検証、生成ABI。buildと73テスト通過。EIP-5792によるアプリからのスマートアカウント設定と、batch IDによる再開を追加。
- 権限API: 本人署名・公式MetaMask委任・5 confirmations後の有効化・即時pause・onchain revokeを実装。実PostgreSQL/Anvilで14項目通過（`docs/evidence/permissions-api.json`）。中断した登録のhashを保持し、確定済みpolicyの期間を保ったまま2件目だけ新しい本人署名で再開。実Chromeと試験用EIP-1193 providerによる22項目も通過（`docs/evidence/browser-permissions.json`）。実MetaMask拡張は別途確認する。
- Solidity: AI接続別の権限と共有予算を同一transactionで強制。36テスト（fuzzを含む）通過、EIP-170サイズ制限内。公式MetaMask DelegationManager・EIP-7702とのローカル統合12件通過（`docs/evidence/local-chain.json`）。公開Amoy配備済み。
- Domain: 単位の厳密変換、期限・共有予算・AI別予算をfail-closedで判定。7テスト通過。
- PostgreSQL: owner署名認証、idempotency、outbox、予算予約、署名済みtransactionを送信前に保存するjournal。実PostgreSQLで6件の同時実行・復旧試験通過。
- UCP: stable 2026-08-25のschemaを固定。discovery、商品検索、cart、配送・署名付きcheckout、在庫予約、AP2付きcomplete、決済後のorder、HTTP署名、webhookを実装。UCPパッケージ12件・API16件のテスト通過。既存EC adapterを追加。公開カタログは2店舗・4商品を読み取り確認し、注文予約から送金・注文復旧はローカル結合試験で確認。
- KMS: 非export鍵のEVM/P-256署名adapter、CRC・署名復元検証。ローカル暗号試験2件通過。Cloud HSMの実EVM/P-256署名を検証済み（`docs/evidence/cloud-kms.json`）。
- AP2: 固定した公式v0.2 SDKでopen→closed mandate、制約・署名検証、receiptを実装。実署名・公式SDK・本人の新しいEIP-712同意とprivate issuerの19件通過。Cloud Run配備と、mandateの一回消費・実決済receiptへの束縛を実装済み。上流仕様との差異は`docs/design/INTEROPERABILITY.md`。

`PAYMENT_PIPELINE=1 BROWSER_PURCHASE=1 node packages/wallet-sdk/scripts/local-integration.mjs`で、本人署名→AP2 private HTTP→UCP complete→x402 HTTP 402/支払署名→実ERC-7710送金→order/署名付きreceiptの68項目を検証。送信応答消失から同一hashで復旧、金額改変拒否、期間超過の本人一件同意も含む。証拠は`docs/evidence/payment-pipeline.json`。これはAnvilと試験tokenでの結合検証。

## 公開環境での確認

[管理画面/API](https://yours-api-110852561536.asia-northeast1.run.app)を公開。mandates・worker・agentは非公開のCloud Run。Cloud Build `12c78537-9a28-49fe-a3a5-5de3ede1b2ee`で既存EC連携を配備し、migration job `yours-migrate-qc5b6`で001〜010を反映。Geminiのページ取得修正はCloud Build `97bb9b8a-6f10-4a11-b274-c4264c044504`、wallet再接続の修正はCloud Build `799a615c-3f7c-462a-8894-1f2bc20ab09d`で追加反映した。

| service | revision | image tag | source |
| --- | --- | --- | --- |
| API / Console | `yours-api-00010-jsk` | `wallet-permissions-20261014` | `c4d7287` |
| worker | `yours-worker-00006-z4v` | `commerce-20261014` | `c785810` |
| mandates | `yours-mandates-00006-cjn` | `commerce-20261014` | `c785810` |
| Gemini agent | `yours-agent-00006-98c` | `catalog-20261014` | `55b074d` |

Cloud SQL接続、HSM公開鍵とdiscoveryの一致、4サービスのhealthと公開範囲を確認（[証拠](evidence/cloud-services.json)）。再接続修正の反映後も4件成功。公開Chromeの1440px・390px表示、JavaScriptエラーなし、検証したbuild assetの配信を確認。後続commitは再配備するまで公開環境の成果に含めない。

Google ADK → Vertex AI `gemini-3.8-flash` → 実Cloud SQL catalogの検索が公開画面のAPI経由で成功（[証拠](evidence/gemini-cloud.json)）。未接続の試用は検索専用で、決済権限を持たない。購入は本人署名・AP2・x402を経由する。

既存ECの2店舗・4商品をyoursの公開UCPへ接続。店舗の送金先設定、商品・価格・在庫と、cursorによる次ページ取得を確認（[公開UCP](evidence/ucp-ec-cloud.json)）。公開Geminiも実ECを検索し、2店舗の価格と品切れを実データに沿って回答した（[Geminiと実EC](evidence/gemini-ec-cloud.json)）。これは検索の確認であり、公開ECでの購入成功はまだ含まない。

商品数の増加に合わせ、Geminiの検索toolへUCP cursorを追加。全商品を尋ねると6件→1件の2ページを実際に取得し、最後の商品まで7件を回答した（[全件検索](evidence/gemini-paginated-cloud.json)）。続きが残る場合は全件取得したと答えないよう指示している。

管理画面は1440pxと390pxで実ブラウザ検証済み（[公開検証](evidence/public-console.json)）。接続、AI別権限、共有予算、停止、注文専用同意、購入品downloadを実APIへ接続。未設定EOAから「ウォレットで承認する」を押すとMetaMaskの設定確認を開始する。画像で報告された`wallet_upgrade_required`の原因を修正し、設定取引の応答消失・ERC-7715・reload・部分登録復旧を含むローカルChromeの22項目を確認（[設計](design/WALLET-ONBOARDING.md)）。公開Amoyで本人のスマートアカウント設定取引の成功と現在の実装を確認済み。実MetaMaskでのAI権限登録完了を確認。本人購入は再確認中。

再読み込み後の「登録を再開」でwalletへ再接続すると、登録画面が閉じる不具合も修正。旧版で同じ停止を再現した。修正版は接続済みの同じ本人・networkを復元し、再接続が必要な場合は入力した条件を保って元の画面へ戻す。接続キャンセル・別walletへの切り替え・条件の再確認を当時の18項目に含めている。source `22bbaea`のGitHub CI [38540356112](https://github.com/Mameta29/yours/actions/runs/38540356112)も全項目成功。

MetaMaskの確認画面が開かず通信エラーになる報告に対し、隠れていたRPCの処理名・番号・理由を表示する修正を追加。`data.originalError`と`cause`の内側のエラーを区別し、署名・要求payloadは表示しない。Cloud Build `bb44fbc4-87b8-4ab4-86a8-8a1c57c2af0e`で反映し、source `fc5b488`の[CI 38545264723](https://github.com/Mameta29/yours/actions/runs/38545264723)、公開画面、4サービスの確認が成功。その後の本人の報告から、`wallet_sendCalls`に含めた`data: "0x"`がMetaMaskの入力検証で拒否されることを特定。データなしの2件の呼び出しは`data`を省略する形に修正した。公式配布の`SendCallsStruct`で旧要求の拒否・新要求の受理を照合し（[証拠](evidence/metamask-send-calls-schema.json)）、SDK68テストとブラウザ18項目が成功。Cloud Build `e11dcea2-40ab-41b3-a590-da5e2d433c52`で公開環境へ反映し、source `10812cf`の[CI 38548876925](https://github.com/Mameta29/yours/actions/runs/38548876925)も全項目成功。公開サービス4件・1440px/390px表示・全JS/CSSの配信hashを確認。本人の実MetaMaskでの登録完了はまだ未確認。

本人の設定取引はAmoyの2 RPCで成功receipt・canonical block・現在の固定7702実装を照合し、APIの`prepare`も201まで進んだ。次の段階では旧consoleがownerの委任を通常の署名として要求しており、MetaMaskの仕様に適合していなかった。SDKのERC-7715権限照会・要求へ切り替え、通常の条件署名にも明示的なEIP712Domainを含めた。権限の署名後にHTTPが失敗しても同じdraftの承認内容で再開する。固定したGate、token、期限、native value禁止の検証は維持。[公式MetaMask allowance builder/decoderとの照合6項目](evidence/metamask-7715-compatibility.json)、SDK73件、ブラウザ22項目が成功。Cloud Build `a69608f8-2e9c-4f43-b722-419a885125dd`で反映し、source `c4d7287`の[CI 38564315751](https://github.com/Mameta29/yours/actions/runs/38564315751)も全項目成功。公開サービス4件、1440px/390px表示、lazy importを含む全6 JS/CSSの配信hashを確認した。詳細は[ウォレット設定](design/WALLET-ONBOARDING.md)。

2026-10-15 00:01 JST、本人の実MetaMask操作によるAI権限登録が完了。ユーザーの画面報告、Cloud Runの`activate` 200、Amoy上のGate/Registryのactive=trueを照合した。AI別上限2,000/5,000 JPYC、共有上限3,000/10,000 JPYC、期限10/22 00:00 JST、policy/permission revisionはともに1。個人のaddress・draft ID・署名を除いた[登録確認](evidence/public-owner-permission.json)を保存。公開購入は未確認。現行登録は委任許可1件・条件署名2件・登録transaction2件を別々に要求するため、接続・ログインとMetaMask内の画面遷移を含めるとクリック数が多い。ユーザーは約10クリックと報告しており、初回操作数の削減は未実装の改善点。

UCP RFC 9421署名、API keyとplatform profileの結び付け、DNSを固定したprofile取得、order webhookのoutbox・inbox・重複排除・非同期auditを実装・配備。非公開workerへの1分間隔のScheduler `yours-outbox`を設定済み。

外部AIのP-256 AP2 holderとEVM agentを分離して実装・配備。注文専用leafとintentを外部AI自身が署名し、yours側は署名の検証とrelayを行う。公式AP2 SDKによる外部holderの提示、実ERC-7710送金、別AIを追加しても共有消費が維持されること、共有予算超過で送信前に止まることと外部client単体の実行を含む68項目のローカル結合検証が成功。外部AI向けclient例、購入するAIの選択、本人だけができるtoken再発行を追加。client単体の公開決済は未確認。

本人限定の注文詳細ページと実ファイルのdownloadを実装・配備。受け取り操作は一つのdigital fulfillment eventと署名付きwebhookにまとめ、同時再試行でも重複しない。実Chromeで注文リンクから実ファイルを受け取る試験を68項目に含めた。source `c785810`のGitHub CI [38532719152](https://github.com/Mameta29/yours/actions/runs/38532719152)も全項目成功。提出用README・構成図・試用手順を公開済み。

## 既存ECの接続（実装・配備済み）

`adapters/jpyc-ec`を新設。登録済みのorigin・店舗ID・送金先だけを使い、実ECの予約・personal_sign・transfer照合を接続する。migration 010で予約の冪等キーとcheckout/AP2の結び付きを永続化。本人の署名・同意を得るまではAP2を発行せず、メールの宛先をAIへ渡さない。workerは確定後に同じtx hashでEC注文を照合し、応答消失から復旧する。

adapter境界の12テスト、AP2 authorityの19テスト、実Chromeを含む68項目のpipeline、権限API14項目、wallet登録18項目が通過。ECのHTTP境界はfixtureで、本人署名と実ERC20 receiptを検証している。実ECの[公開catalogの読み取り](evidence/ec-public-catalog.json)とは区別する。公開ECでの本人購入は未確認。

注文の受付を配達完了とは扱わない。外部ECの商品は本人が準備・同意したcheckoutを使用し、yours Marketのcart/create-checkoutを直接流用しない。配送先・variant・必須追加optionのある商品、返金処理は対象外。

## 次に完了する事項

- 公開Amoyで本人の資産から実購入。外部AI client単体はローカルの実HTTP・実送金で確認済み、公開Amoyは未確認。
- 返金処理は未実装。現在は対応capabilityとして公開しない。
- 実処理のデモ動画とDashboard提出。

ローカルの最新結合証拠は[決済pipeline](evidence/payment-pipeline.json)。API/SDK、Anvil、公開Google Cloud、公開Amoyの証拠はそれぞれ区別する。
