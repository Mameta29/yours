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

`infra/bootstrap.sh`を実行済み。必要なAPI、Artifact Registry、サービス別アカウント、署名用途別のCloud KMS HSM鍵を作成。Cloud SQL `yours-db`（PostgreSQL 16）、専用DB利用者・Secret Managerを作成し、ユーザー承認済みの`infra/IAM.md`の権限を適用。Cloud BuildでAPI imageを構築し、Cloud Run migration job `yours-migrate-k9skl`は03:52 UTCに成功。runtime DB権限の縮小、サービス配備は継続中。

Polygon Amoyにyours専用Gate `0x42eec579df8fb1f87ae3bddbb90c6a4a9f790504` とRegistry `0xa5524081a219422ee5247afDEda40791E953eF2B`を配備。Cloud HSM relayerの実署名を使用し、5 confirmationsとblock hashを検証。txは`0x7ffe2572d92c1b32b33ec16cead5156b1a9c7ec2a0381f9e5bc5048a121664b9`。公開情報・code hashは`deployments/amoy.json`。これは配備の証拠であり、公開Amoyでの購入成功はまだ確認していない。

## 変更と確認

初期状態は空repo。親ECの未コミット作業と他worktreeを保持し、独立cloneで作業する。抽出元のrevisionとファイル一覧はEXTRACTION.jsonに保存した。

- SDK: 型付きowner同意、委任検証、生成ABI。buildと48テスト通過。
- 権限API: 本人署名・公式MetaMask委任・5 confirmations後の有効化・即時pause・onchain revokeを実装。実PostgreSQL/Anvilで9項目通過（`docs/evidence/permissions-api.json`）。ブラウザ拡張の操作は未検証。
- Solidity: AI接続別の権限と共有予算を同一transactionで強制。36テスト（fuzzを含む）通過、EIP-170サイズ制限内。公式MetaMask DelegationManager・EIP-7702とのローカル統合12件通過（`docs/evidence/local-chain.json`）。公開Amoy配備済み。
- Domain: 単位の厳密変換、期限・共有予算・AI別予算をfail-closedで判定。7テスト通過。
- PostgreSQL: owner署名認証、idempotency、outbox、予算予約、署名済みtransactionを送信前に保存するjournal。実PostgreSQLで6件の同時実行・復旧試験通過。
- UCP: stable 2026-08-25のschemaを固定。discovery、商品検索、cart、配送・署名付きcheckout、在庫予約を実装。UCPパッケージ5件・API8件のテスト通過。complete、実決済、注文確定、外部EC adapterは実装中。
- KMS: 非export鍵のEVM/P-256署名adapter、CRC・署名復元検証。ローカル暗号試験2件通過。Cloud HSMの実EVM/P-256署名を検証済み（`docs/evidence/cloud-kms.json`）。
- AP2: 固定した公式v0.2 SDKでopen→closed mandate、制約・署名検証、receiptを実装。実署名・公式SDK・本人の新しいEIP-712同意とprivate issuerの17件通過。Cloud Run配備、利用回数の決済連動は継続中。上流仕様との差異は`docs/design/INTEROPERABILITY.md`。

まだ新しい公開サービス・公開chain実決済は確認していない。Gemini/Vertex AI、管理画面、Cloud Run配備、運用復旧の結合検証を続ける。
