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

`infra/bootstrap.sh`を実行済み。必要なAPI、Artifact Registry、サービス別アカウント、署名用途別のCloud KMS HSM鍵を作成。Cloud SQL `yours-db`（PostgreSQL 16）の作成operationは2026-10-14 02:45 UTCに正常完了。Cloud Runサービス、DB利用者・秘密情報・IAM・実行用コンテナはまだ配備していない。

## 変更と確認

初期状態は空repo。親ECの未コミット作業と他worktreeを保持し、独立cloneで作業する。抽出元のrevisionとファイル一覧はEXTRACTION.jsonに保存した。

- SDK: 型付きowner同意、委任検証、生成ABI。buildと48テスト通過。
- Solidity: AI接続別の権限と共有予算を同一transactionで強制。36テスト（fuzzを含む）通過、EIP-170サイズ制限内。公式DelegationManagerとの統合・公開Amoy配備は未完。
- Domain: 単位の厳密変換、期限・共有予算・AI別予算をfail-closedで判定。7テスト通過。
- PostgreSQL: owner署名認証、idempotency、outbox、予算予約、署名済みtransactionを送信前に保存するjournal。実PostgreSQLで6件の同時実行・復旧試験通過。
- UCP: stable 2026-08-25のschemaを固定。discovery、商品検索、cart、配送・署名付きcheckout、在庫予約を実装。UCPパッケージ5件・API8件のテスト通過。complete、実決済、注文確定、外部EC adapterは実装中。
- KMS: 非export鍵のEVM/P-256署名adapter、CRC・署名復元検証。ローカル暗号試験2件通過。Cloud HSMへの実署名は未確認。
- AP2: 固定した公式v0.2 SDKでopen→closed mandate、制約・署名検証、receiptを実装。実署名と公式SDK相互運用11件通過。private HTTP service、本人同意、利用回数のDB連動は未完。上流仕様との差異は`docs/design/INTEROPERABILITY.md`。

まだ新しい公開サービス・公開chain実決済は確認していない。Gemini/Vertex AI、管理画面、Cloud Run配備、運用復旧の結合検証を続ける。
