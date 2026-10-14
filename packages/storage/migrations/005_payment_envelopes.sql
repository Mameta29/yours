CREATE TABLE payment_envelopes (
 intent_id uuid PRIMARY KEY REFERENCES intents(id), envelope jsonb NOT NULL,
 payload jsonb NOT NULL, payload_hash text NOT NULL,
 accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
