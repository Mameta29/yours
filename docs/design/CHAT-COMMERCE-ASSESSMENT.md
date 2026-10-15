# LINEで購入を任せる構成の評価

2026-10-15。ユーザーは、ETHGlobalで使ったLINE/Telegram・進捗表示・World例外承認を再利用し、yoursで権限設定、LINEで購入を実演する案と作業量を質問した。この文書は調査・提案であり、移植・配備の完了記録ではない。

## 確認した差分

- 現在のyoursは、商品・数量・店舗を固定した本人の`TaskConsent`を毎回求める。Geminiの`authorized_tasks` / `purchase_task`はその同意がある注文だけを実行する。LINEで「買って」と送るだけの購入は未実装。
- 外部ECの現adapterは予約ごとの本人`personal_sign`も必須。単に画面の確認を省いたり、LINE IDを支払同意に見立てても、この境界は通らない。
- 現yoursの例外承認は新しいEIP-712本人署名であり、Worldフローは未接続。
- 旧ECにはLINE/Telegramの受信、本人walletとの一回用コード連携、イベント重複排除、永続outbox、選定理由・商品カード・進捗、注文専用World承認がある。`ShoppingService`は事前のsession/policyに従って購入を進める。
- 旧`ShoppingService`はECのDB・`agent_inventory`・旧Gate/Facilitatorに結合している。コピーして配備先だけ変更すると、現在のyoursの権限・UCP/AP2・通常EC在庫を使う動作にはならない。
- 公開ステージング`/api/agent/setup-status`で、80002、commerce/chat/LINE/World/selectorの設定有効とmanifest一致を確認。設定確認は今回のLINE実購入の通し検証ではない。

参照した実装:

- yours: `services/api/src/tasks.ts`、`ec-checkout.ts`、`approvals.ts`、`services/agent/yours_agent/service.py`。
- 旧EC: `packages/storefront/src/server/agent/channels.ts`、`line-entry.ts`、`shopping.ts`、`shopping-chat.ts`、`purchase-progress.ts`、`approvals.ts`、`world.ts`、`server/usecases/authorize-x402-transfer.ts`。

## 推奨する構成

LINE → Cloud Runのチャネル受付 → 永続キュー → ADK / Vertex AI Gemini → yoursのUCP・AP2・決済 → JPYC EC。管理画面は権限、LINE連携、停止、共有予算と履歴に使う。既存ECは商品・在庫・注文の接続先として保つ。

1. 初回にwallet所有者とLINE利用者を結び、店舗・金額・数量/商品条件・期限・繰返しの範囲を示して、条件内自動購入への明示的な事前同意を得る。既存のwallet支出権限だけから、自動購入の同意を推定しない。注文メールも本人設定として保存し、LLMへ渡さない。
2. AP2のopen mandatesをその事前同意へ束縛し、個々の注文へclosed mandatesを提示する。現在の一商品タスクから一般化するため、失効、合計予算、注文の一回消費、条件違反の試験が必要。
3. EC側でこの委任証明とyoursのGate決済を検証できる受付経路を追加するか、対応する既存の委任購入経路をadapter化する。予約の本人署名チェックを削除して無認証化しない。旧経路を使う場合もyoursの権限・UCP/AP2が実際に適用されることを確認する。
4. LINEの一つのイベントを一つの購入へ固定する。再配信・再起動・決済結果不明時は同じ注文を復旧する。返信と決済を別の永続ジョブにする。既存LINEアカウントを使う場合は他のEC機能の受信を維持し、受信先を無差別に切り替えない。
5. 価格変更・在庫切れを実APIから確認し、必要ならカタログを更新して再選定する。未登録店舗や金額超過は本人へ戻す。Worldで登録本人の新しい認証と当該注文への明示同意を確認し、その注文だけ再開する。店舗変更時はAP2の注文内容も新しい同意と一致させる。

AP2は事前に条件を承認してagentが実行する[Human Not Present](https://ap2-protocol.org/ap2/flows/#human-not-present)を定義しており、毎回の商品選択画面がプロトコル上必須ということではない。LINEは[webhookの非同期処理と再配信](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)を想定するため、Cloud Runでは[Cloud Tasks等の永続処理](https://docs.cloud.google.com/run/docs/triggering/using-tasks)へつなぐ。

旧World実装は`https://sandbox.auth.world.org`の開発用IdP。これを再利用するデモと、本番Worldの本人保証を区別する。新しいoriginで使う場合はcallbackの登録・本人との結び付けを確認する。

## 審査員に見せる情報

LLMの回答だけを成功証拠にせず、検索結果・選定理由・ルール判定・実際の操作・確定結果を短い進捗カードにする。通知は実イベントから生成し、架空の検索や成功を演出しない。上限と支払許可の判定はサーバー・コントラクトが強制する。

想定する場面:

1. yoursでCHEAP・1回1,000円等を本人が設定する。
2. LINEで「お米10kg買っといて」。CHEAP 800円・在庫あり、登録店舗、上限内を示して条件内購入を完了する。
3. 同じ依頼でCHEAPの在庫切れを確認。HIGH 2,400円を候補にし、未登録店舗/金額超過の理由と、追加承認前には送金していないことを表示する。
4. 本人がWorldとその注文への同意を行い、一件だけ購入を再開。LINEの確定通知、yoursの予算、ECの注文を照合する。

CHEAP 10kgの通常在庫は先の補充で20個。1回で売り切れる実演には、撮影前に対象SKUを1個へ調整する必要がある。この調査では在庫を再変更していない。

## 概算

コードを読んだ段階の開発作業量で、完了時刻の約束ではない。

- LINE受付・連携・進捗を現在の購入同意画面につなぐ段階: 半日〜1日。条件内でも都度署名が残る。
- 事前委任、ECの委任受付、Gemini再選定、World一件例外、再送/復旧と公開実機検証まで: 合計3〜5日程度が初期見積もり。外部認証・wallet・EC受付で追加修正が出れば延びる。

実装時は、条件内の800円購入をLINEから公開ECまで通すことを最初の到達点とし、その後に在庫切れとWorld例外を足す。LINEだけ先につなぐ段階を、条件内自動購入の完成とは説明しない。
