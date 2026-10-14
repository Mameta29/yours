# 実装の継続記録

更新: 2026-10-14。repo: https://github.com/Mameta29/yours

## 確定した方向

製品名はyours。UCP対応の委任決済API/SDKを中心に、本人向けAI権限管理画面を提供する。既存ECは接続先、Geminiは最初の購入agent。Google Cloudで動作させ、実署名・実決済・障害復旧まで検証する。小さなcommitを積み重ねる。

## 実装順序

- [x] 独立repoの準備、Google Cloudハッカソン要項の再確認。
- [ ] EC非依存SDK・Gate・既存試験の抽出。
- [ ] 複数AIの権限・共有予算・停止・例外同意。
- [ ] PostgreSQLの永続状態・認証・API/SDK。
- [ ] UCP discovery/catalog/cart/checkout/orderとEC adapter。
- [ ] AP2実署名・制約・receiptとstablecoin handler。
- [ ] x402実行・journal・KMS署名・chain照合。
- [ ] Gemini ADKと外部agent接続。
- [ ] 管理画面・wallet承認・本人確認。
- [ ] Google Cloud構成、相互運用・障害試験、README・試用資料。

## 外部設定

Google Cloudの配備先project IDを確認中。現在のCLI設定は別用途の可能性があるため、そのprojectへ新resourceを作成していない。実装・ローカル検証は独立して進める。

## 変更と確認

初期状態は空repo。親ECの未コミット作業と他worktreeを保持し、独立cloneで作業する。まだアプリの動作・新しいcloud配備・実決済は確認していない。
