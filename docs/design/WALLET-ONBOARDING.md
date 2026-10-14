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

SDKの10項目と、実Chrome→HTTP API→PostgreSQL→Anvil/公式MetaMask contractsの10項目を確認。通常EOAからの実EIP-7702 transactionと、設定状態の応答消失後に再送しないことを含む。[ブラウザ検証](../evidence/browser-permissions.json)は試験用EIP-1193 providerによるもので、実MetaMask拡張の公開Amoy成功を意味しない。

仕様の根拠: [MetaMaskのbatch transactionと対応network](https://docs.metamask.io/metamask-connect/evm/guides/send-transactions/batch-transactions/)、[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)。
