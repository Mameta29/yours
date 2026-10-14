# アプリから始めるウォレット設定

2026-10-14。対象: Polygon Amoy / PC版MetaMask。

通常のEOAのまま権限登録すると、サーバの `wallet_upgrade_required` で停止していた。ウォレットの委任応答だけでは、EIP-7702の設定がchainへ反映された証拠にならない。

「ウォレットで承認する」を押すと、必要な場合だけEIP-5792の `wallet_getCapabilities` と `wallet_sendCalls` を使ってMetaMaskの設定・確認画面を開く。MetaMaskの設定メニューを探す操作は不要。本人による確認は必要であり、登録全体の署名・transactionを1回の承認に統合したものではない。

- `ready` / `supported` を確認し、`atomicRequired: true` で0 POL・空calldataの自分宛て2件だけを要求する。token送金・approveは含まない。network feeは本人walletが負担する。
- 別のsmart-account実装が設定済みなら変更しない。実装が未設定のEOAか、manifestで固定したMetaMask実装だけを扱う。
- batch IDをbrowser内へ即座に保存する。再読込後は同じIDを照合し、通信切断やtimeoutを新規送信の根拠にしない。
- walletの成功表示だけで通過させず、独立したRPCから5 confirmations・canonical block hash・そのblockと現在の7702 implementationを照合する。
- 設定完了後、既存の本人署名によるGate/Registry登録へ進む。途中で中断した登録は同じ条件・共有予算の期間を維持して再開する。
- ownerの秘密鍵をアプリ、サーバ、AIへ入力・送信する工程はない。

再読み込み後にSIWEのsessionだけが残る場合、再接続の成功時に登録画面が閉じる問題も修正した。以前の画面で同じ経路を再現し、修正版では入力した1回・期間上限を保ったまま戻り、登録が完了することを確認している。

- `eth_accounts`と`eth_chainId`だけで、ログイン済み本人と一致する接続先を復元する。候補が一意でない場合は本人が選ぶ。ページを開いただけでは接続要求・network変更・署名要求を出さない。
- 再接続が必要な場合は戻り先と入力値を画面内で保持する。同じ本人のログイン後に元の画面へ戻し、条件を再確認してから登録する。接続キャンセル後も戻り先を失わない。
- 別walletでログインした場合は以前の本人の操作を引き継がない。accountやnetworkが実際に変わった場合は画面を閉じてログアウトする。同じ値の再通知ではログアウトしない。

SDKの設定・RPCエラー分類の20項目と、実Chrome→HTTP API→PostgreSQL→Anvil/公式MetaMask contractsの18項目を確認。通常EOAからの実EIP-7702 transactionと、設定状態の応答消失後に再送しないことを含む。[ブラウザ検証](../evidence/browser-permissions.json)は試験用EIP-1193 providerによるもので、実MetaMask拡張の公開Amoy成功を意味しない。

仕様の根拠: [MetaMaskのbatch transactionと対応network](https://docs.metamask.io/metamask-connect/evm/guides/send-transactions/batch-transactions/)、[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)。

MetaMaskのRPC失敗は一律の通信エラーにまとめず、接続権限不足・要求形式・不明なbatch ID・確認待ちを区別する。「エラーの詳細」で処理名、RPC番号、長さ制限・hex/URL/credential除去済みの理由だけを表示する。要求payloadや署名をログへ送信しない。元の失敗理由にかかわらず、batch照合エラーだけで保存済みIDを消したり新しい取引を自動送信したりしない。
