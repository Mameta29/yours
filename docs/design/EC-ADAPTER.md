# 既存ECとの接続

yoursのUCP gatewayから、既存JPYC ECの公開APIへ接続する。既存ECの実装・配備は変更しない。UCPのcheckout署名はyoursが変換した注文に対して行い、既存ECが直接UCP/AP2を実装したとは扱わない。

1. 登録済みorigin・店舗ID・送金先に限って公開catalogを取得する。chainはAmoy。デモの固定成功・mainnet・送金先変更は拒否する。
2. 本人が商品とAIを選ぶ。実ECへ冪等な予約を作り、HTTP 402のnetwork・token・amount・payToと予約専用personal_sign文面を独立照合する。
3. 本人がECの予約専用署名とyoursのタスク同意を行う。ECの所有確認成功前にはAP2を発行しない。AP2とタスクは同じcheckoutに束縛する。
4. AIは準備済みUCP checkoutを取得し、AP2/x402を進める。Gateが本人walletから登録された店舗へ送金する。
5. 5 confirmationsとGate eventを照合後、同じtx hashを既存ECへ通知する。通知に失敗しても追加送金せず、outboxから同じ予約・同じhashで再試行する。
6. 送金確定とECの注文受付は別々に表示する。ECの`fulfillment_status: ready`を商品受け取り完了とは扱わない。

初期の接続対象は、配送・variant・必須追加optionのないAmoy商品。未対応の選択項目を省略して購入しない。注文メールは本人が入力した宛先へ既存ECが送る。メールアドレスはAIのタスクや公開UCP documentへ含めない。

実装・試験・公開接続の状態は[実装記録](../IMPLEMENTATION.md)に記録する。HTTP境界のfixture試験を、既存ECへの公開購入成功として扱わない。
