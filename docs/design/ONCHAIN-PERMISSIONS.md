# AIごとの権限と共有予算

`YoursPurchaseGate`は既存の注文・risk・本人追加承認・ERC-7710委任検証を維持し、`AgentPermissionRegistry`の個別予算を同じtransaction内で消費する。後続の送金が失敗すれば、共有予算・個別予算・承認の使用状態もすべてrollbackする。

本人はEIP-712でconnection ID、実行鍵、店舗と送金先、一回上限、期間上限、有効期限、revisionを承認する。署名domainは`yours Agent Permissions` / `1`、chainとRegistry addressに結び付く。nonceは再利用不可。実行鍵やrevisionを変更しても、connection IDをキーとする使用済み予算を保持する。新しいconnectionの作成も本人の署名が必要。

共有Policyの期間開始時刻と長さは変更不可。個別予算はその期間に揃え、別々のAIによる支出も共有予算に合算する。停止・失効・古い実行鍵・署名改変は一件限定の追加承認でも解除しない。金額と店舗の超過理由は従来の1/2/4ビットを共用し、承認は注文・risk証拠・本人に結び付く。

Solidityの36件の試験（うち2件は各256回のfuzz）が通過。複数AIの合算、鍵交換、再有効化、送金失敗、上限例外を検証。これらはMockManager/Tokenを使用する単体試験であり、公式DelegationManagerとの統合・Amoy公開試験とは区別する。

EIP-170のbytecode上限を超えないよう、署名検証をimmutableなvalidatorへSTATICCALLで分離。optimizer runs=1 / solc 0.8.28 / viaIRでGate runtimeは24,373 bytes、initcodeは47,379 bytes。今後も`forge build --sizes`を必須にする。
