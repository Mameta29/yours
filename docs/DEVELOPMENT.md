# 開発・検証・配備

## 環境

Node.js 22.14以上 / pnpm 10.7.1 / Foundry（Prague対応Anvil）/ Python 3.12以上 / uv / PostgreSQL 16を用意する。

```sh
pnpm install --frozen-lockfile
createdb yours_test
pnpm build
pnpm typecheck
TEST_DATABASE_URL=postgresql://localhost/yours_test pnpm test
```

`createdb`はDBが未作成の場合だけ必要。ローカル試験scriptの標準接続先は `postgresql://localhost/yours_test`。他プロジェクトや公開環境のDBを使わない。

AP2 authorityは公式SDKのcommitを `uv.lock` で固定する。

```sh
cd services/mandates
uv sync --frozen
uv run pytest -q
```

## 実chainとHTTPの結合試験

repo rootで公式MetaMask frameworkを準備する。scriptはcommitを固定し、必要なsubmoduleとcontractsをbuildする。

```sh
bash scripts/prepare-framework.sh
pnpm build
```

別terminalで使い捨てのAnvilを起動する。

```sh
anvil --host 127.0.0.1 --port 18812 --chain-id 31337 --hardfork prague --silent
```

以下は**順に**実行する。期限試験はAnvilの時刻を変更するため、同じchainに対して並列実行しない。

```sh
PAYMENT_PIPELINE=1 BROWSER_PURCHASE=1 node packages/wallet-sdk/scripts/local-integration.mjs
node services/api/scripts/permissions-integration.mjs
node services/api/scripts/browser-permissions.mjs
```

最初のscriptはloopback・Anvil・chain ID・framework commitを確認した上で、公式account/Manager/enforcerとyours contractsを配備する。使い捨てのowner/AI署名鍵、試験token、HTTPのAPI/AP2 authorityを使い、実送金・改変拒否・二重送信防止・外部AIを検証する。起動したAPI/AP2 processは終了時に閉じる。ブラウザ試験にはChromeが必要。既存ECのHTTP境界は制御可能なfixtureを使用し、本人署名とERC20の実receiptを検証する。公開ECへ試験注文は送らない。

公開鍵・transaction hash・試験範囲を `docs/evidence/` に出力する。秘密鍵を証拠やGitへ保存しない。ローカルtrialを公開Amoyや実MetaMask拡張の結果として扱わない。

## Google Cloud

公開projectは `yours-511602`。別projectへの適用ではscript内のproject・service account・URLを明示的に変更する。既存CLIのdefault projectには依存しない。

- `infra/bootstrap.sh`: API、署名用途別KMS/HSM、Cloud SQL、Artifact Registry、専用service account。
- `infra/IAM.md` / `infra/iam.sh`: accountと鍵・secretのアクセス範囲。
- `infra/configure-database.py` / `infra/runtime-database-role.py`: migrationとruntimeのDB権限を分離。
- `infra/cloudbuild.yaml`: API/worker/console、AP2 authority、Gemini agentのimageをbuild。
- `infra/deploy.py`: migrationを先に適用し、固定service identity・Secret Manager参照でCloud Runを配備。
- `infra/scheduler.py`: private workerの定期実行。
- `infra/smoke.py`: 公開範囲、health、DB、discovery署名鍵をread-onlyで検証。

既存projectでの反映例。tagは変更ごとに一意にする。

```sh
gcloud builds submit . --project=yours-511602 --region=asia-northeast1 \
  --config=infra/cloudbuild.yaml --substitutions=_TAG=your-change-tag \
  --service-account=projects/yours-511602/serviceAccounts/yours-build@yours-511602.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://yours-511602-cloudbuild-source/source
python3 infra/deploy.py --tag your-change-tag --public
python3 infra/smoke.py
```

Gateの公開配備先と17件のcode/proxy pinは `deployments/amoy.json`。アプリ更新のたびにGateを再配備しない。productionの秘密鍵はCloud HSMに保持し、owner鍵・AI鍵の環境変数をブラウザへ埋め込まない。

## 外部ECの登録

`deployments/ec-merchants-amoy.json`のorigin・店舗ID・slug・送金先を固定し、`infra/deploy.py`がAPIとworkerへ同一の`EC_MERCHANTS_JSON`を設定する。実行環境へ任意originを登録する公開APIは設けない。ローカルHTTPは`NODE_ENV=test`でのみ使用できる。公開catalogは60秒のキャッシュ、購入時は毎回実ECで価格・在庫・予約を確認する。[接続の設計](design/EC-ADAPTER.md)
