-- Houses & Humans — Phase 1 schema.
-- Deliberately minimal: users + adventures only. Message and NPC tables
-- are designed and introduced in their own implementation phases.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adventures (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL DEFAULT 'New Adventure',
  spine      TEXT,               -- story spine summary (populated in a later phase)
  hook       TEXT,               -- plot hook summary (populated in a later phase)
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'archived')),
  character  TEXT NOT NULL DEFAULT '{}',  -- JSON snapshot {name, race, classes[], hp, notes}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_adventures_user ON adventures(user_id, updated_at DESC);
