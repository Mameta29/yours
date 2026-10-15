# LINEから、自分の条件で買い物を任せる

Webのyoursで権限を設定し、普段の依頼は既存の **JPYC EC (Staging) / @922eatwh** へ送る。Google Cloud上のGeminiが実ECの在庫と価格から商品を選び、本人のウォレットから店舗へ支払う。

## 初回設定

1. PCのMetaMaskが使えるブラウザで[LINE設定](https://yours-api-110852561536.asia-northeast1.run.app/?view=line)を開く。登録済みの同じウォレットでログインする。
2. My Geminiの購入条件を確認する。主デモでは **1回1,000 JPYC、24時間5,000 JPYC、許可店舗CHEAP RICE SHOP・HIGH RICE SHOP**。共有予算は既存の使用額を維持する。
3. 「LINEで使う」で注文メールを入力し、連携コードを発行する。「LINEでコードを送る」から既存Botへコードを送信する。
4. PCへ戻り、表示されたLINE名が自分であることを確認する。チェックを付け「署名して、LINEで使う」を押す。署名はLINEアカウント・AI接続・現在のpolicy・期限・注文メールを束縛する。
5. LINEへ「5kg入りのお米を1袋買って」と送る。通常の購入ごとにMetaMaskを開く必要はない。

## 実行中に見えるもの

1. 「お店のカタログと最新の在庫を確認しています」
2. 実データに基づく選択理由、商品、数量、店舗、合計金額
3. 条件内なら支払い処理。条件外なら送金前に停止し、理由と注文確認カード
4. 実際の送金確定と店舗受付後に購入結果・店舗注文番号・取引へのリンク

ここで表示するのはツールの処理結果と短い選択理由であり、モデルの内部思考の実況ではない。「支払い確定」と「ECの注文受付」は別に確認する。

## 一件だけの承認

ユーザーの指定により、追加のLINE Loginチャネルは使わない。登録済みのLINEに届いたカードの「この一件だけ許可」を押す方式とする。**LINEへ再ログインした証明やWorldの本人保証ではない。** LINEアカウントへのアクセスを失った場合のリスクを、独立した別要素認証と同等には扱わない。

元のLINE署名付きpostbackをprivate authorityが再検証する。送信者、ウォレットの連携同意、注文専用token、変更不能な注文hash、有効期限、鮮度が一致すると、その一件への短命なHSM承認を発行する。別のLINE、普通のチャット文、URLを開くだけ、期限切れ、停止済み連携では解除できない。許可店舗・予算の恒久的な設定は変わらない。

LINEへ「停止」と送ると新しい購入権限を直ちに停止する。停止後の依頼を旧ETHGlobal Botの購入処理へ戻さない。既に送信済みの取引は巻き戻さず、同じhashで照合する。

## 接続構成

既存ECのWebhook → 元のLINE署名を維持してyours APIへ転送 → Cloud SQLの永続queue → 非公開Cloud Run chat → Gemini / Google ADK → UCP catalog・checkout → AP2 authority → x402 → Gate → 実ECへの注文登録。

ECのLINE資格情報は移動・出力しない。固定staging bridgeが元のHMACを検証し、yoursの公開鍵に固定した短命なHSM署名を確認して通知・profile取得を実行する。private authorityも独立してHMACを照合する。LINE識別子、注文メール、元Webhookは用途を束縛したAES-GCMで暗号化する。チャット処理用SAは署名鍵・Vertex権限を持たない。

商品データの接続は登録した2店舗の **EC REST API**。ECのDBをGeminiへ直接渡す方式やMCP接続ではない。yours側ではUCPへ正規化する。全店舗の自動接続を意味しない。

## 撮影する流れ

Webの権限 → LINEへ依頼 → CHEAPから購入 → ECの注文と在庫減少 → 同じ依頼 → HIGHの提案で停止 → 「この一件だけ許可」 → 同じ注文の購入完了 → 元の権限が変わっていないことを確認する。

2026-10-15 23:55 JST、ユーザー指定の撮影用にCHEAPの5kg（400 JPYC）の通常在庫を1個へ変更した。別容量への置き換えを避けるため、CHEAPの10kgは一時的に0個とした（変更前は両方20個）。HIGHの5kg（1,200 JPYC）は20個。撮影では両店舗を許可し、1回の上限を1,000 JPYCにする。CHEAP 400 JPYCは条件内、HIGH 1,200 JPYCは金額上限によって停止する。店舗の制限を見せたい場合は、代わりにHIGHだけ許可店舗から外す。2回とも「5kg入りのお米を1袋買って」と依頼する。品切れやモデル判断を固定の成功表示で演出しない。

2026-10-16 00:19 JST、実LINEからCHEAPの5kg・400 test JPYCの購入が成立。店舗注文受付、通常在庫1→0、LINEへの結果通知を確認した。[公開取引の証拠](evidence/public-line-cheap-purchase.json)。このときは未許可店舗への一件承認を実行済み。HIGHの金額上限超過のシナリオは別途確認する。

## 確認の区分

- ローカル: 実PostgreSQL・公式MetaMask contracts・実AP2 HTTP authority・実ERC20送金でLINE経路の購入、条件超過停止、一件承認、再送・応答消失・停止を検証。GeminiとLINEの外部通信は明示した試験fixture。公開LINEでの実購入とは区別する。
- 画面: 実ChromeでLINE設定・注文詳細・390px幅を検証。
- 公開: 配備先と実機結果は[実装記録](IMPLEMENTATION.md)の最新LINE項目へ記録する。既存のyours Market購入の証拠を、LINEや外部ECでの購入成功として扱わない。

[決済結合試験](evidence/payment-pipeline.json) · [ブラウザ検証](evidence/workspace-browser.json) · [権限表](../infra/IAM.md)
