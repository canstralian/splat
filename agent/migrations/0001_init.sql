-- Agent runtime relational schema (Cloudflare D1 / SQLite).
-- The Run is the aggregate root. run_events (evidence) and agent_memory are
-- children keyed by run/session and are never independent aggregates.

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  agent_version     TEXT NOT NULL,
  status            TEXT NOT NULL,
  input             TEXT NOT NULL,
  intent            TEXT,
  outcome           TEXT,
  error             TEXT,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 0, -- optimistic-concurrency guard
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);

-- Append-only structured evidence ledger. `seq` orders events within a Run so
-- the execution can be deterministically reconstructed (replay).
CREATE TABLE IF NOT EXISTS run_events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  stage         TEXT NOT NULL,
  verification  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL,          -- JSON
  artifact_key  TEXT,                   -- optional R2 pointer for large payloads
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_seq ON run_events (run_id, seq);

-- Durable, derived per-session memory. Writes are idempotent via
-- last_idempotency_key.
CREATE TABLE IF NOT EXISTS agent_memory (
  session_id           TEXT NOT NULL,
  key                  TEXT NOT NULL,
  value                TEXT NOT NULL,
  last_idempotency_key TEXT,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
