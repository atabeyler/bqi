-- M4: job orchestration. Postgres-backed queue (SELECT ... FOR UPDATE SKIP
-- LOCKED) rather than a separate broker -- BCI must run standalone
-- (including air-gapped/sovereign deployments per spec section 52), and a
-- broker is one more moving part that isn't justified at this scale yet.

CREATE TABLE IF NOT EXISTS scan_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by     UUID NOT NULL REFERENCES users(id),
  target           TEXT NOT NULL,
  requested_class  TEXT NOT NULL,
  scope_id         UUID REFERENCES authorized_scopes(id),
  status           TEXT NOT NULL DEFAULT 'QUEUED',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  locked_by        TEXT,
  locked_at        TIMESTAMPTZ,
  timeout_at       TIMESTAMPTZ,
  result           JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scan_jobs_status_check CHECK (status IN (
    'QUEUED', 'DISCOVERY', 'ANALYZING', 'NORMALIZING', 'VERIFYING',
    'CORRELATING', 'SCORING', 'REPORTING', 'COMPLETED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  CONSTRAINT scan_jobs_requested_class_check CHECK (requested_class IN (
    'PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_org_id ON scan_jobs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_queued ON scan_jobs(status, created_at) WHERE status = 'QUEUED';

-- Worker health (spec section 48: an engine/worker failing must not make the
-- overall run silently look successful). Workers upsert their own heartbeat
-- row; a worker that stops heartbeating is inferred STALE by last_seen_at
-- age, not by an explicit "I died" message it can no longer send.
CREATE TABLE IF NOT EXISTS job_workers (
  worker_id     TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'IDLE',
  current_job   UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_workers_status_check CHECK (status IN ('IDLE', 'BUSY'))
);
