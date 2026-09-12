-- Q1: the worker needs to know a job's target TYPE (not just the raw
-- string) to pick the right engines. Backfilled from the authorized_scopes
-- row that actually granted the job (see services/policyEngine.js and
-- services/jobQueue.js#enqueueScan) -- never independently re-declared by
-- the caller, so it can never disagree with what was actually authorized.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS target_type TEXT;

-- Per-engine execution outcome for one job -- lets a job's summary say
-- exactly which engines ran, which were skipped and why (spec section 48:
-- one dead engine must not silently look like full coverage).
CREATE TABLE IF NOT EXISTS scan_job_engine_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  engine_id   TEXT NOT NULL,
  status      TEXT NOT NULL, -- COMPLETED, SKIPPED, FAILED
  detail      TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scan_job_engine_runs_job_id ON scan_job_engine_runs(job_id);
