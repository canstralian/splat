-- Scope derived agent memory to the authenticated owner.
-- Legacy rows are retained under an empty owner and therefore remain inaccessible
-- to authenticated principals rather than being guessed or reassigned.

CREATE TABLE agent_memory_owner_scoped (
  owner_user_id       TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  key                 TEXT NOT NULL,
  value               TEXT NOT NULL,
  last_idempotency_key TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, session_id, key)
);

INSERT INTO agent_memory_owner_scoped (
  owner_user_id, session_id, key, value, last_idempotency_key, updated_at
)
SELECT '', session_id, key, value, last_idempotency_key, updated_at
FROM agent_memory;

DROP TABLE agent_memory;
ALTER TABLE agent_memory_owner_scoped RENAME TO agent_memory;

CREATE INDEX idx_agent_memory_owner_session
  ON agent_memory (owner_user_id, session_id, updated_at);
