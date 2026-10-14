# AP2 authority

Cloud RunでIAM認証を必須にする内部service。public APIと決済workerだけに`roles/run.invoker`を付与し、Gemini serviceやブラウザから直接呼び出せる状態にはしない。

`POST /v1/issue`は、DBに保存したtaskと期限5分のEIP-712本人署名を独立に検証する。署名はchain、Gate、本人、AI接続、商品・上限・期限、nonceに束縛される。同じ同意の再試行は同じmandateを返す。本人の秘密鍵は取得しない。

`/v1/present`はGeminiのAP2 holder鍵を使用するが、発行済みの制約とmerchantの署名を検証してから結果を返す。外部AIは登録した自身の公開鍵に対応する署名を提出する。`/v1/verify`の成功だけでは決済を確定しない。APIがowner行をlockしたtransaction内でmandate利用を一回だけ予約し、workerがonchain条件と確定receiptを照合する。

`/v1/receipts`はDB上で確定済みの取引と実注文だけを対象にする。SDKの開発用ファイルログは無効化し、auditには識別子とhashを記録する。

```sh
# 先にstorageのmigrationを適用する
UV_CACHE_DIR=../../.local/uv-cache uv sync --frozen
UV_CACHE_DIR=../../.local/uv-cache uv run pytest -q
uv run uvicorn yours_mandates.service:from_environment --factory --host 0.0.0.0 --port 8080
```

productionは`ENVIRONMENT=production`、`DATABASE_URL`、`PUBLIC_ORIGIN`、`GATE_ADDRESS`、公開merchant JWK、`AP2_ISSUER_KEY` / `AP2_AGENT_KEY`のKMS version名を必要とする。private keyによるproduction起動は禁止する。2026-10-14時点で17件の暗号・公式SDK相互運用・実PostgreSQL試験が通過。Cloud Run配備は未完。
