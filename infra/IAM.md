# 配備する権限

対象projectは`yours-511602`のみ。ユーザー・組織・既存EC projectのIAMは変更しない。以下を`iam.sh`で設定する。

| Service account | Project上の権限 | 個別resourceの権限 |
|---|---|---|
| yours-api | Cloud SQL Client | `ucp-merchant`鍵の署名、`yours-db-runtime` / `yours-chat-encryption-key` secret参照 |
| yours-worker | Cloud SQL Client | `relayer / merchant / risk / price / agent`鍵の署名、`yours-db-runtime` secret参照 |
| yours-mandates | Cloud SQL Client | `ap2-issuer / ap2-agent / human`鍵の署名、`yours-db-runtime` / `yours-chat-encryption-key` secret参照 |
| yours-chat | Cloud SQL Client | `yours-db-runtime` secret参照。KMS・Vertex・LINE資格情報への権限なし |
| yours-agent | Vertex AI User | なし。KMSとDB secretを参照しない |
| yours-migrate | Cloud SQL Client | `yours-db-migrate` secret参照 |
| yours-build | Logging Writer | Artifact Registry `yours` repoへのimage push |

これにより各backendは指定された鍵で署名し、指定DBへ接続できる。HSM秘密鍵そのもののexportはできない。LLMを実行する`yours-agent`に署名権限はない。workerは送金前にownerの委任・AP2・onchain予算を検証する。

Cloud Run作成時は別途、APIからagent/mandates/worker、workerからmandates、schedulerからworkerへの呼び出しだけを許可する。API/consoleのHTTPS入口以外は公開しない。Cloud Buildのsource用bucketができたら、そのbucketだけにbuildアカウントのObject Viewerを設定する。

LINE追加時は `chat-setup.py` で上表のchat用SAと暗号鍵を作る。API / scheduler → chat、chat → APIのみ呼び出しを追加する。APIのLINE内部処理はchatのGoogle OIDC identityとDBの有効なwork leaseを両方検証する。LINEのChannel SecretとAccess Tokenは既存staging EC内に保持し、yoursのHSM署名を検証する専用bridge経由で使用する。

2026-10-14: 最初のIAM実行は自動承認審査で拒否された。agentのDB/secret権限とbuildのproject全体へのArtifact Registry/Storage権限を削除し、上記の具体的な構成を提示。新repo・専用Cloud projectであることを説明し、ユーザーから「であれば大丈夫です」と承認を得た。

API→workerは署名鍵へのアクセスではなく、認証済み注文の永続outboxを待たずに処理するための呼び出し。workerは独立してAP2・本人委任を検証する。定期schedulerは障害復旧を担当する。
