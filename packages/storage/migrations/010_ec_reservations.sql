-- Email is forwarded to the merchant and never stored in this table or an AI task.
CREATE TABLE ec_reservations (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id),
 connection_id uuid NOT NULL,
 merchant_id text NOT NULL,
 request_hash text NOT NULL,
 consent_id uuid UNIQUE REFERENCES task_consents(id),
 checkout_id uuid UNIQUE REFERENCES merchant_sessions(id),
 quote jsonb,
 signature_hash text,
 authorized_at timestamptz,
 settled jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,connection_id) REFERENCES connections(account_id,id),
 CHECK((consent_id IS NULL AND checkout_id IS NULL AND quote IS NULL) OR
       (consent_id IS NOT NULL AND checkout_id IS NOT NULL AND quote IS NOT NULL)),
 CHECK((authorized_at IS NULL AND signature_hash IS NULL) OR
       (authorized_at IS NOT NULL AND signature_hash IS NOT NULL))
);
CREATE INDEX ec_reservations_account ON ec_reservations(account_id,created_at DESC);
