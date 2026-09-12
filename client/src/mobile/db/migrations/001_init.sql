-- BQI mobile (Android) local database — initial schema.
--
-- Deliberately kept identical to desktop/db/migrations/001_init.sql (same
-- table/column names, same sync semantics) so both offline clients speak
-- the exact same protocol against the shared server/src/routes/sync.js
-- API. Kept as a separate file (not a cross-package import) because Vite
-- doesn't resolve files outside client/'s project root -- if the schema
-- ever changes, update both copies together.
--
-- organization_id is carried on every table even though the current
-- backend has no multi-tenant/organization concept (identity is user_code
-- only, see server/src/routes/auth.js) — it stays NULL today and is
-- reserved so a future institutional/organization rollout doesn't need a
-- destructive schema change, without this build inventing fake org data.

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,               -- client-generated UUID; matches analyses.client_id on the server
  server_id INTEGER,                 -- server's numeric analyses.id, once known (NULL until first synced)
  user_id TEXT NOT NULL,
  organization_id TEXT,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'analysis',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | conflict | error
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  ai_provider TEXT,
  fraud_transaction_count INTEGER,
  fraud_flagged_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_analyses_user ON analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_analyses_sync_status ON analyses(sync_status);
CREATE INDEX IF NOT EXISTS idx_analyses_deleted_at ON analyses(deleted_at);

-- Persistent, resumable outbound sync queue. One row per local write that
-- still needs to reach the server. operation_id (the row's own id) is sent
-- to the server as-is so a retried/replayed push is idempotent there too
-- (see server/src/routes/sync.js's sync_operations ledger).
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,               -- operation_id (UUID)
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,           -- analyses.id (client-generated UUID)
  op TEXT NOT NULL,                  -- create | update | delete
  payload TEXT,                      -- JSON snapshot captured at enqueue time
  base_version INTEGER,
  device_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | in_flight | done | failed
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);

-- Both sides of an unresolved conflict, kept until the user (or an
-- automatic policy) resolves it -- never silently overwritten.
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_payload TEXT NOT NULL,
  local_base_version INTEGER,
  server_payload TEXT,
  server_version INTEGER,
  server_deleted INTEGER NOT NULL DEFAULT 0,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT              -- kept_local | kept_server | NULL (unresolved)
);

CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON conflicts(resolved_at);

-- Small key/value table for sync bookkeeping (the pull cursor, etc.) that
-- doesn't warrant its own table.
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_meta (
  device_id TEXT PRIMARY KEY,
  platform TEXT,
  created_at TEXT NOT NULL,
  last_authorized_user_id TEXT,
  last_authorized_at TEXT
);
