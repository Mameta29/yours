CREATE TABLE order_receipts (
 intent_id uuid PRIMARY KEY REFERENCES intents(id), document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
