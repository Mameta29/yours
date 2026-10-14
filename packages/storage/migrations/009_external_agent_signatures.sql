-- The unsigned challenge is immutable even after the agent's signatures are
-- attached to the payment context and the x402 payload hash changes.
ALTER TABLE payment_envelopes ADD COLUMN signing_challenge text;
UPDATE payment_envelopes SET signing_challenge=payload_hash;
