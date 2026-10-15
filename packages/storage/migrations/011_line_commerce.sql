-- A LINE identity alone is not payment authority. Activation requires a wallet
-- signature over the exact channel identity, connection, policy and expiry.
CREATE TABLE line_links (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 connection_id uuid NOT NULL, code_hash text UNIQUE NOT NULL,
 code_expires_at timestamptz NOT NULL, user_hash text, user_cipher text,
 display_name text, email_cipher text NOT NULL,
 consent jsonb, owner_signature text, expires_at timestamptz,
 activated_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,connection_id) REFERENCES connections(account_id,id),
 CHECK ((user_hash IS NULL) = (user_cipher IS NULL)),
 CHECK (activated_at IS NULL OR (consent IS NOT NULL AND owner_signature IS NOT NULL AND user_hash IS NOT NULL))
);
CREATE UNIQUE INDEX line_one_active_user ON line_links(user_hash) WHERE activated_at IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX line_one_active_account ON line_links(account_id) WHERE activated_at IS NOT NULL AND revoked_at IS NULL;
CREATE TABLE line_inbox (
 body_hash text PRIMARY KEY, body_cipher text NOT NULL, signature text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE line_events (
 id uuid PRIMARY KEY, event_id text NOT NULL UNIQUE,
 body_hash text NOT NULL REFERENCES line_inbox(body_hash),
 link_id uuid NOT NULL REFERENCES line_links(id),
 decision jsonb, consent_id uuid UNIQUE REFERENCES task_consents(id),
 mandate_id uuid UNIQUE REFERENCES mandates(id), intent_id uuid UNIQUE REFERENCES intents(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','selecting','preparing','paying','approval_required','completed','failed','canceled')),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE task_consents ADD COLUMN line_event_id uuid UNIQUE REFERENCES line_events(id);
CREATE TABLE line_messages (
 id uuid PRIMARY KEY, event_id uuid REFERENCES line_events(id), link_id uuid NOT NULL REFERENCES line_links(id),
 dedupe_key text UNIQUE NOT NULL, document jsonb NOT NULL, delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE line_login_attempts (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 link_id uuid NOT NULL REFERENCES line_links(id), intent_id uuid REFERENCES intents(id),
 state_hash text UNIQUE NOT NULL, cookie_hash text NOT NULL, secrets_cipher text NOT NULL,
 snapshot_hash text, consented_at timestamptz NOT NULL DEFAULT now(),
 token_cipher text, subject_hash text, authenticated_at timestamptz,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approvals ADD COLUMN line_login_attempt_id uuid UNIQUE REFERENCES line_login_attempts(id);
-- A capability opens only an order-specific confirmation page. It cannot
-- approve or pay without the registered person's fresh LINE Login proof.
CREATE TABLE line_approval_links (
 token_hash text PRIMARY KEY, token_cipher text NOT NULL, event_id uuid NOT NULL UNIQUE REFERENCES line_events(id),
 intent_id uuid NOT NULL UNIQUE REFERENCES intents(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
