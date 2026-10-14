ALTER TABLE connections ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
CREATE TABLE permission_drafts (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 connection_id uuid NOT NULL, document jsonb NOT NULL,
 expires_at timestamptz NOT NULL, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,connection_id) REFERENCES connections(account_id,id)
);
CREATE TABLE wallet_grants (
 connection_id uuid NOT NULL REFERENCES connections(id), token_address text NOT NULL,
 context text NOT NULL, document jsonb NOT NULL,
 valid_after bigint NOT NULL, valid_until bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,token_address)
);
