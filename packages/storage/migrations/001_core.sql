CREATE TABLE accounts (
 id uuid PRIMARY KEY, address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
 chain_id integer NOT NULL CHECK(chain_id > 0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(address,chain_id)
);
CREATE TABLE owner_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, authenticated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_challenges (
 nonce text PRIMARY KEY, address text NOT NULL, message text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE connections (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), provider text NOT NULL,
 agent_address text CHECK(agent_address ~ '^0x[0-9a-f]{40}$'), ap2_public_jwk jsonb,
 token_hash text UNIQUE, status text NOT NULL CHECK(status IN ('pending','active','paused','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,id)
);
CREATE TABLE policies (
 account_id uuid PRIMARY KEY REFERENCES accounts(id), policy_id text NOT NULL, revision integer NOT NULL,
 gate_address text NOT NULL, token_address text NOT NULL, token_decimals integer NOT NULL CHECK(token_decimals BETWEEN 0 AND 77),
 currency text NOT NULL CHECK(currency IN ('JPY','USD')), document jsonb NOT NULL,
 activation_tx text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE permissions (
 connection_id uuid PRIMARY KEY REFERENCES connections(id), revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL, owner_signature text NOT NULL, activation_tx text,
 status text NOT NULL CHECK(status IN ('pending','active','revoked')), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intents (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 connection_id uuid NOT NULL, merchant_id text NOT NULL, checkout_id text NOT NULL,
 revision text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic > 0 AND amount_atomic < power(2::numeric,256)),
 period_index bigint NOT NULL CHECK(period_index >= 0),
 state text NOT NULL CHECK(state IN ('prepared','approval_required','authorized','signing','submitted','confirmed','failed','canceled')),
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, reasons jsonb NOT NULL DEFAULT '[]',
 expires_at timestamptz NOT NULL, transaction_hash text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(account_id,connection_id) REFERENCES connections(account_id,id),
 UNIQUE(account_id,merchant_id,checkout_id)
);
CREATE INDEX intents_budget ON intents(account_id,period_index,state);
CREATE TABLE approvals (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES intents(id), snapshot_hash text NOT NULL,
 proof jsonb NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency (
 scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 status integer, response jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key)
);
CREATE TABLE audit_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid REFERENCES accounts(id),
 actor text NOT NULL, action text NOT NULL, resource_id text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_account ON audit_events(account_id,sequence DESC);
CREATE TABLE outbox (
 id uuid PRIMARY KEY, topic text NOT NULL, dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
 available_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, completed_at timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(available_at) WHERE completed_at IS NULL;
CREATE TABLE signer_lanes (
 chain_id integer NOT NULL, signer text NOT NULL, next_nonce bigint NOT NULL CHECK(next_nonce>=0),
 PRIMARY KEY(chain_id,signer)
);
CREATE TABLE signed_transactions (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE REFERENCES intents(id),
 chain_id integer NOT NULL, signer text NOT NULL, nonce bigint NOT NULL,
 unsigned_payload jsonb NOT NULL, raw_transaction text, transaction_hash text UNIQUE,
 state text NOT NULL CHECK(state IN ('reserved','signed','broadcast','confirmed','reverted')),
 lease_token uuid NOT NULL, lease_until timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
 receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chain_id,signer,nonce),
 CHECK ((raw_transaction IS NULL AND transaction_hash IS NULL AND state='reserved') OR (raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL AND state<>'reserved'))
);
CREATE TABLE webhook_inbox (
 source text NOT NULL, event_id text NOT NULL, payload_hash text NOT NULL, payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, PRIMARY KEY(source,event_id)
);
CREATE TABLE oauth_codes (
 code_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), client_id text NOT NULL,
 redirect_uri text NOT NULL, code_challenge text NOT NULL, scopes text[] NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE merchant_products (
 merchant_id text NOT NULL, id text NOT NULL, title text NOT NULL, description text NOT NULL,
 currency text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), image_url text,
 stock integer NOT NULL CHECK(stock>=0), requires_shipping boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true, attributes jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(merchant_id,id)
);
CREATE TABLE merchant_sessions (
 id uuid PRIMARY KEY, merchant_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('cart','checkout')),
 actor text NOT NULL, platform_profile text NOT NULL, ap2_required boolean NOT NULL,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL,
 document jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory_reservations (
 session_id uuid NOT NULL REFERENCES merchant_sessions(id), merchant_id text NOT NULL,
 product_id text NOT NULL, quantity integer NOT NULL CHECK(quantity>0), expires_at timestamptz NOT NULL,
 released_at timestamptz, PRIMARY KEY(session_id,product_id),
 FOREIGN KEY(merchant_id,product_id) REFERENCES merchant_products(merchant_id,id)
);
CREATE TABLE merchant_orders (
 id uuid PRIMARY KEY, session_id uuid NOT NULL UNIQUE REFERENCES merchant_sessions(id),
 document jsonb NOT NULL, transaction_hash text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mandate_challenges (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), connection_id uuid NOT NULL REFERENCES connections(id),
 checkout_id text NOT NULL, audience text NOT NULL, nonce text NOT NULL UNIQUE,
 snapshot_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 UNIQUE(connection_id,checkout_id,snapshot_hash)
);
CREATE TABLE mandates (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), connection_id uuid NOT NULL REFERENCES connections(id),
 task jsonb NOT NULL, task_hash text NOT NULL, open_checkout text NOT NULL, open_payment text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
