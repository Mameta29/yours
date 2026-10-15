-- The selected UX uses an authenticated LINE postback, not a new LINE Login.
-- Keep the earlier (unused) Login tables for migration/audit compatibility.
ALTER TABLE line_approval_links ADD COLUMN snapshot_hash text;
UPDATE line_approval_links a SET snapshot_hash=i.snapshot_hash FROM intents i WHERE i.id=a.intent_id;
ALTER TABLE line_approval_links ALTER COLUMN snapshot_hash SET NOT NULL;
CREATE TABLE line_order_actions (
 id uuid PRIMARY KEY, event_id text UNIQUE NOT NULL,
 body_hash text NOT NULL REFERENCES line_inbox(body_hash),
 token_hash text NOT NULL REFERENCES line_approval_links(token_hash),
 link_id uuid NOT NULL REFERENCES line_links(id), intent_id uuid NOT NULL REFERENCES intents(id),
 action text NOT NULL CHECK(action IN ('approve','cancel')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 last_error text
);
ALTER TABLE approvals ADD COLUMN line_action_id uuid UNIQUE REFERENCES line_order_actions(id);
