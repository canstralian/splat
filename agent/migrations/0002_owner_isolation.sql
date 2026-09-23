-- Per-user isolation: tag every Run with the authenticated owner so read
-- endpoints can enforce that users only ever see their own Runs.

ALTER TABLE runs ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs (owner_user_id, created_at);
