-- Adds real stop and soft-archive lifecycle support without changing RBAC.
ALTER TABLE controlled_proof_runs
  DROP CONSTRAINT IF EXISTS controlled_proof_runs_status_check;

ALTER TABLE controlled_proof_runs
  ADD CONSTRAINT controlled_proof_runs_status_check
  CHECK (status IN ('ANALYZING', 'READY', 'FAILED', 'CANCELLED'));

ALTER TABLE controlled_proof_runs
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_archive
  ON controlled_proof_runs(org_id, archived_at, created_at DESC);
