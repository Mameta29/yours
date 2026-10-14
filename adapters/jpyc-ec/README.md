# JPYC EC adapter

既存ECを変更せず、実カタログ、予約固有の本人確認、決済後の注文照合をyoursへ接続する。URL・店舗ID・送金先はoperatorの設定で固定する。`JpycEcClient`は署名鍵を持たず、送金もしない。

対応する既存EC API:

- `GET /api/v1/shops/:slug/products`
- `POST /api/v1/checkout` → 実予約とHTTP 402 / `PAYMENT-REQUIRED`
- `POST /api/v1/checkout/authorize-transfer` → 予約専用の本人署名をECが検証
- `POST /api/v1/checkout` + `PAYMENT-SIGNATURE` → 既存のERC20送金を照合

yoursのGateが送った確定済みtransactionを、ECの`erc20-transfer`方式で照合する。ECへ新たな送金要求やEIP-3009署名を渡さない。UCP側のERC-7710 handlerと、接続先ECのtransfer照合は別の境界。

UCPの商品IDは`ec:<店舗slug>/<既存の商品UUID>`。本人向け`/api/owner/tasks/prepare`に同じ商品のID・AI・金額上限・メール・再試行用UUIDを渡すと、実予約と署名内容を返す。本人確認を終えたタスクの`checkout_id`をAIが取得し、通常のUCP/AP2/x402へ進む。既存ECの商品はこの準備済みcheckoutを使う。yours Marketのcart/create-checkout APIへ直接流用しない。

対象はAmoyの配送不要・variantなし・必須追加optionなしの商品。checkoutの金額・在庫は公開catalogのキャッシュだけでは確定しない。network・token・payTo・金額・personal_sign文面の一つでも一致しなければ、承認・送金へ進めない。

```sh
pnpm --filter @yours/jpyc-ec test
PAYMENT_PIPELINE=1 BROWSER_PURCHASE=1 node packages/wallet-sdk/scripts/local-integration.mjs
```

[公開カタログの読み取り](../../docs/evidence/ec-public-catalog.json)と、[ローカルの実署名・送金・応答消失試験](../../docs/evidence/payment-pipeline.json)を区別して記録する。接続先HTTPのfixtureは公開ECでの購入成功を意味しない。[設計](../../docs/design/EC-ADAPTER.md)
