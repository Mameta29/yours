UPDATE policies SET token_address=lower(token_address),gate_address=lower(gate_address);
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY, account_id uuid REFERENCES accounts(id), connection_id uuid REFERENCES connections(id),
 mandate_id uuid REFERENCES mandates(id), client_request_id text NOT NULL,
 token_hash text UNIQUE, message text NOT NULL, status text NOT NULL CHECK(status IN ('running','completed','failed')),
 result jsonb, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,client_request_id)
);
CREATE TABLE api_rate_limits (
 key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
