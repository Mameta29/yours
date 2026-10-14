ALTER TABLE approvals ADD COLUMN owner_signature text;
ALTER TABLE approvals ADD COLUMN authenticated_at timestamptz;
