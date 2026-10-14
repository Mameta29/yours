# yours

AI works for you. UCP対応の委任決済API/SDKと、本人向けの権限管理画面を作る。

- 入口はREADMEとdocs/IMPLEMENTATION.md。実装・試験・配備・実取引を区別して更新する。
- 小さく検証可能な単位でcommitする。既存ECの作業中ファイルを変更・stageしない。
- UCP stable 2026-08-25とAP2 v0.2を基準にする。dummy署名・固定の決済成功で対応済みとしない。
- UCPは商取引、AP2は同意の証拠、x402は支払連携、Gateはchain上の権限強制。
- 資産は本人walletに保持。owner秘密鍵は取得・保存しない。実行鍵はLLMへ渡さない。
- 試験chainはPolygon Amoy/80002。mainnetへの送金・配備を既定にしない。
- 予算超過等は本人の新しい認証と注文専用同意で一件のみ許可。失効・改変・再利用は解除しない。
- 新旧の鍵・grantでも共有予算をリセットしない。署名txを永続保存してから送信する。
- READMEは第5回Agentic AI Hackathon with Google Cloud向け。未検証事項を成果と書かない。
- 期間より品質を優先する。調査・実装にスキルを使わない。
