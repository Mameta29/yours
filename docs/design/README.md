# yoursの設計

## 責務

- 本人の管理画面: AI接続、grant、予算、停止、注文専用の例外承認。
- Authority: 認証とgrant、AI別・共有の予算、型の決まった実行要求。
- UCP: discovery、catalog、cart、checkout、orderとmerchant adapter。
- AP2: 決定的な承認画面からの同意、open/closed mandate、receipt。
- Settlement: x402、Gate、署名済みtxの永続化、送信と結果照合。
- Agent: Geminiが検索・比較・再計画する。秘密鍵やgrant更新権限は持たない。

## 不変条件

資産は本人walletに保持する。新しい鍵・接続・grantでも使用済みの期間予算を消さない。一つの注文は一回しか支払わない。送信済みの結果が不明なら、支払なしと断定して再購入しない。共有予算は同じchainで原子的に強制する。

例外の本人同意は対象注文・金額・宛先・chain・期限に束縛する。失効・改変・署名不正・承認再利用は例外承認で解除しない。既存World認証の開発modeを本番の本人保証と扱わない。

## データ所有者

店舗は商品、在庫、価格、税・送料、注文、配送・返金を管理する。yoursは本人とagent接続、grant、mandate、支払実行と照合を管理する。ECのDB credentialをyoursへ渡さない。

## 仕様

UCP stable 2026-08-25、AP2 v0.2。標準と独自stablecoin handlerの対応範囲を公開する。商品・数量に束縛したAP2の購入タスクと、長期のwallet grantを分ける。宣言したcapabilityには実処理を実装する。

## 完成の検証

実署名での商品購入、別merchant/clientとの相互運用、権限超過・改変・再利用の拒否、共有予算競合、worker再起動と通知重複、注文と返金の照合を試験する。モックでの単体試験と、実HTTP・DB・chain・cloudの通し検証を区別して記録する。

## 管理画面と実行の見せ方

[ワークスペースの設計](CONSOLE-EXPERIENCE.md)と[3分の撮影手順](../DEMO-SCRIPT.md)。画面上の進捗は実際の購入状態・監査記録に基づく。
