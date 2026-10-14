# アプリから始めるウォレット設定

2026-10-14。対象: Polygon Amoy / PC版MetaMask。

通常のEOAのまま権限登録すると、サーバの `wallet_upgrade_required` で停止していた。ウォレットの委任応答だけでは、EIP-7702の設定がchainへ反映された証拠にならない。

「ウォレットで承認する」を押すと、必要な場合だけEIP-5792の `wallet_getCapabilities` と `wallet_sendCalls` を使ってMetaMaskの設定・確認画面を開く。MetaMaskの設定メニューを探す操作は不要。本人による確認は必要であり、登録全体の署名・transactionを1回の承認に統合したものではない。

- `ready` / `supported` を確認し、`atomicRequired: true` で0 POL・calldataなしの自分宛て2件だけを要求する。`data`は省略する。MetaMaskの`optional(StrictHexStruct)`は明示的な`data: "0x"`をRPC -32602で拒否するため、空文字列を送らない。token送金・approveは含まない。network feeは本人walletが負担する。
- 別のsmart-account実装が設定済みなら変更しない。実装が未設定のEOAか、manifestで固定したMetaMask実装だけを扱う。
- batch IDをbrowser内へ即座に保存する。再読込後は同じIDを照合し、通信切断やtimeoutを新規送信の根拠にしない。
- walletの成功表示だけで通過させず、独立したRPCから5 confirmations・canonical block hash・そのblockと現在の7702 implementationを照合する。
- 設定完了後、`wallet_getSupportedExecutionPermissions`でAmoyのERC-20 allowance、expiry、redeemerを確認し、`wallet_requestExecutionPermissions`でMetaMaskの購入権限画面を開く。ownerの`Delegation`を通常の`eth_signTypedData_v4`で署名させない。
- 返された委任について、token・Gateのみのredeemer・期限・native value禁止・親署名・nonceをSDK/APIで検証する。その後のGate/Registryの本人署名にはviemの`signTypedData`を使い、raw RPCにも`EIP712Domain`の型を含める。
- 承認済みcontextは同じowner・chain・connection・draftに紐付けてbrowserへ保存する。後続HTTPの失敗後も同じcontextをサーバで検証できる。途中で中断した登録は同じ条件・共有予算の期間を維持して再開する。
- ownerの秘密鍵をアプリ、サーバ、AIへ入力・送信する工程はない。

再読み込み後にSIWEのsessionだけが残る場合、再接続の成功時に登録画面が閉じる問題も修正した。以前の画面で同じ経路を再現し、修正版では入力した1回・期間上限を保ったまま戻り、登録が完了することを確認している。

- `eth_accounts`と`eth_chainId`だけで、ログイン済み本人と一致する接続先を復元する。候補が一意でない場合は本人が選ぶ。ページを開いただけでは接続要求・network変更・署名要求を出さない。
- 再接続が必要な場合は戻り先と入力値を画面内で保持する。同じ本人のログイン後に元の画面へ戻し、条件を再確認してから登録する。接続キャンセル後も戻り先を失わない。
- 別walletでログインした場合は以前の本人の操作を引き継がない。accountやnetworkが実際に変わった場合は画面を閉じてログアウトする。同じ値の再通知ではログアウトしない。

SDK全73項目と、実Chrome→HTTP API→PostgreSQL→Anvil/公式MetaMask contractsの22項目を確認。通常EOAからの実EIP-7702 transaction、設定状態の応答消失後の再送防止、ERC-7715への経路変更、承認後のHTTP失敗・reload後の復旧を含む。[ブラウザ検証](../evidence/browser-permissions.json)は試験用EIP-1193 providerによるもので、実MetaMask拡張の公開Amoy登録完了を意味しない。

仕様の根拠: [MetaMaskのbatch transactionと対応network](https://docs.metamask.io/metamask-connect/evm/guides/send-transactions/batch-transactions/)、[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)。

MetaMaskのRPC失敗は一律の通信エラーにまとめず、接続権限不足・要求形式・不明なbatch ID・確認待ちを区別する。「エラーの詳細」で処理名、RPC番号、長さ制限・hex/URL/credential除去済みの理由だけを表示する。要求payloadや署名をログへ送信しない。元の失敗理由にかかわらず、batch照合エラーだけで保存済みIDを消したり新しい取引を自動送信したりしない。

公開環境で報告された`wallet_sendCalls / RPC -32602 / calls.0.data`は、この明示的な空calldataが原因だった。`@metamask/eip-5792-middleware@3.0.3`の配布済み`SendCallsStruct`でも旧SDKの要求が同じ理由で拒否され、修正版の要求が通ることを[検証](../evidence/metamask-send-calls-schema.json)した。SDK試験providerにも当該境界の制約を入れ、旧コードが失敗することを確認してから修正。ブラウザ試験は省略された`data`を空bytesとして実EIP-7702取引へ変換し、登録・再開の18項目が成功。実MetaMaskでの本人の公開Amoy登録完了は別途確認する。

その後、本人が共有した設定取引はAmoyの2 RPCで成功receipt・canonical block・現在の固定7702実装を確認した。Cloud Runでも設定確認後の`prepare`が201まで進んでおり、同じ設定取引の再送は不要。これはウォレットの切り替え成功であり、AI権限登録・購入の成功ではない。

次の署名工程では旧consoleがownerの`Delegation`をraw署名要求として渡していた。MetaMask 13.48の配布コードと[公式仕様](https://docs.metamask.io/smart-accounts-kit/concepts/advanced-permissions/)は、通常の委任署名とAdvanced Permissionsを区別し、解釈できない外部のowner委任を拒否する。consoleを既存SDKのERC-7715経路へ切り替え、署名拒否を別経路で迂回するfallbackは設けない。[Amoy対応](https://docs.metamask.io/smart-accounts-kit/get-started/supported-networks/)は資料上の対応だけで決めず、接続中のwalletへ照会する。必要な制限を提供しないwalletでは停止する。

公式`@metamask/7715-permission-types@2.0.0`のallowance caveat builder/decoderでも、SDKが送るtoken・MaxUint256・開始時刻・Gate redeemer・期限が互換で、固定したAmoyのManager/enforcerと一致することを[確認](../evidence/metamask-7715-compatibility.json)。上限は従来どおりGate/Registryで強制する。browser試験はraw owner委任を拒否し、通常の条件署名には明示したdomain型を要求する。権限照会・権限要求・条件署名にも、機密値を除いたRPCの処理名・番号・理由を表示する。
