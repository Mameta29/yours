# yours

**AIは、あなたのために動く。**

yoursは、ユーザーが選んだAIに、予算・店舗・期限を指定して購入を任せるUCP対応の委任決済基盤です。資産は本人のウォレットに保持し、AI向けAPI/SDKと本人向けの権限管理画面を提供します。

[第5回 Agentic AI Hackathon with Google Cloud](https://zenn.dev/hackathons/google-cloud-japan-ai-hackathon-vol5)向けに開発しています。

## 解決する課題

買い物をAIに任せたいとき、商品選択だけでなく、支出の上限、本人確認へ戻る条件、停止、決済後の追跡が必要になります。複数のAIを使っても、誰に何を許可したかを一画面で管理できるようにします。

## 動作の流れ

1. 本人がwalletを接続し、使うAIと購入条件を承認します。
2. AIがUCPで商品と会計を確認し、AP2で対象購入への同意を証明します。
3. x402の支払処理とGateによる検証を通じて、条件内の支払いを実行します。
4. 条件を超える注文は本人の確認へ戻り、決済・注文・返金の履歴を追跡できます。

## Google Cloud構成

Geminiによる購入判断とCloud Runでの実行を軸に、Cloud SQLで権限と決済journalを保持し、Cloud KMS/HSMで実行鍵を保護する構成です。稼働確認前のresourceを配備済みとは表示しません。

## 実装状況と検証

現在の進捗・実行した検証・残作業は[実装記録](docs/IMPLEMENTATION.md)、仕様と受入条件は[設計](docs/design/README.md)、提出物と要項の対応は[ハッカソン要項](docs/HACKATHON.md)に記録します。

デプロイURL・動画・試用手順は、実際の稼働・撮影が完了してから追加します。試験対象はPolygon Amoy testnet（80002）です。
