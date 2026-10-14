# 再現可能な検証

`local-chain.json`は`YoursPurchaseGate`、MetaMask公式DelegationManager / EIP-7702 account / enforcersを、使い捨てのAnvilへ配備した結果。資産は生成した本人walletに置き、AIへの事前送金は行わない。token、swap router、risk/human署名者はローカル試験用であり、公開Amoyや本人のブラウザwalletでの成功を表すものではない。

```sh
pnpm install --frozen-lockfile
bash scripts/prepare-framework.sh
pnpm --filter @yours/contracts build
pnpm --filter @yours/wallet-sdk build
# 別terminalで実行。公開RPCには接続しない。
anvil --host 127.0.0.1 --port 18812 --chain-id 31337 --hardfork prague --silent
node packages/wallet-sdk/scripts/local-integration.mjs
# PostgreSQL yours_testを用意し、AP2/worker/APIを含めて検証する場合
pnpm --filter @yours/api... --filter @yours/worker... build
PAYMENT_PIPELINE=1 node packages/wallet-sdk/scripts/local-integration.mjs
```

scriptはchain ID・Anvil・loopback URL・framework commitを検証し、生成した秘密鍵は保存も出力もしない。エビデンスには公開アドレス、取引hash、試験範囲だけを保存する。
