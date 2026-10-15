# JPYC ECのお米で実演する

主デモは **yoursで条件設定 → LINEで購入依頼 → CHEAPから購入 → 売切れ後にHIGHを提案 → 一件承認**。[3分の撮影台本](DEMO-SCRIPT.md)と[LINE連携手順](LINE-COMMERCE.md)を使用する。

## 接続の実態

Gemini → yoursのUCP API → JPYC EC adapter → ステージングECの公開REST API。yoursはECのDBへ直接接続せず、商品APIから取得した情報を検索用に保存する。画面の検索は最大60秒のキャッシュ、LINEの購入選択は最新カタログを強制取得し、購入準備ではECへ実予約を作って在庫・金額・送金先を再確認する。

MCPはこの経路で使わない。UCPを提供するのはyoursであり、EC自体がUCP/AP2を直接提供するという意味ではない。登録対象はCHEAP・HIGHの2店舗。他店舗の追加には接続設定と送金先の確認が必要。現adapterの対象はAmoy・配送不要・variantなし・必須追加optionなしの商品。

**今回使うのは通常ECの商品と在庫。** ETHGlobal時の「AI購入の在庫」は別SKU・別経路で、今回の在庫変更・購入では使わない。

## 撮影用の商品と権限

| 店舗 | 商品 | 金額 | 撮影開始時の通常在庫 |
| --- | --- | --- | --- |
| CHEAP | お米 5kg | 400 test JPYC | 1個 |
| CHEAP | お米 10kg | 800 test JPYC | 一時0個 |
| HIGH | コシヒカリ 5kg | 1,200 test JPYC | 1個以上 |

My Geminiの1回上限1,000円、24時間5,000円、許可店舗CHEAP・HIGH。共有上限3,000 / 10,000円は維持する。こうするとCHEAPは通常購入でき、HIGHは金額上限で止まる。店舗制限を見せたい場合はHIGHだけを許可店舗から外すが、同じ動画で二つの理由を混ぜる必要はない。

LINEへ **5kg入りのお米を1袋買って** と送信する。購入完了後に同じ文をもう一度送る。2回目は在庫のあるHIGHを提案し、送金前に確認カードを表示する。**この一件だけ許可**で同じ注文を再開する。

## 公開検証

2026-10-16 00:19 JST、実LINE依頼からCHEAP 5kg・400 test JPYCの購入が成立。ECの注文番号 `ORD-20261015-DTCBWEP7`、通常在庫1→0、LINEへの結果通知を確認。実Amoyのreceipt・本人から店舗への正確な移動を2 RPCで照合した。この注文時はCHEAPが未許可店舗だったため、一件承認を使っている。[CHEAPの証拠](evidence/public-line-cheap-purchase.json)。

同日00:42 JST、HIGH 5kg・1,200 test JPYCの注文 `ORD-20261015-BW4RUC9X` も成立。1回上限1,000円で停止し、本人のLINEによる一件承認後に支払った。通常在庫20→19、2 RPCでの送金照合、元の1,000円上限の維持を確認。[HIGHの証拠](evidence/public-line-high-purchase.json)。

同日00:44 JST、撮影用にCHEAP 5kgの在庫だけ0→1へ補充した。CHEAP 10kgは0、HIGH 5kgは19。公開ECの商品APIでも反映を確認した。[在庫の証拠](evidence/rice-demo-ready.json)。在庫補充は購入や使用済み予算を巻き戻す処理ではない。

## Web画面だけで試す場合

Web版は商品を選んで本人がその購入に署名する方式も保持する。LINE版は初回の連携同意と、そのLINEからの明示的な購入依頼を使うため、通常購入ごとのMetaMask署名は不要。この二つの入口を混同しない。

注文詳細では支払確定、店舗受付、店舗注文番号、実取引を確認する。店舗で受付中の場合は同じ注文を照合し、追加購入しない。外部ECの商品をyours Marketのダウンロード商品と同じ表示にはしない。
