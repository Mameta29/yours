CREATE TABLE task_consents (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 connection_id uuid NOT NULL, task jsonb NOT NULL, task_hash text NOT NULL,
 nonce text NOT NULL UNIQUE CHECK(nonce ~ '^0x[0-9a-f]{64}$'),
 valid_until bigint NOT NULL, owner_signature text, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,connection_id) REFERENCES connections(account_id,id)
);
ALTER TABLE mandates ADD COLUMN consent_id uuid UNIQUE REFERENCES task_consents(id);
CREATE TABLE mandate_consumptions (
 mandate_id uuid PRIMARY KEY REFERENCES mandates(id),
 intent_id uuid NOT NULL UNIQUE REFERENCES intents(id),
 checkout_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 verified jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mandate_presentations (
 mandate_id uuid NOT NULL REFERENCES mandates(id), checkout_id text NOT NULL,
 checkout_hash text NOT NULL, document jsonb NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mandate_id,checkout_id,checkout_hash)
);
