-- Controlled Proof scanner execution belongs to the isolated worker/data
-- plane. This explicit link lets the existing Postgres queue dispatch the
-- fixed, system-generated proof plan without adding a second queue.
ALTER TABLE scan_jobs
  ADD COLUMN IF NOT EXISTS controlled_proof_run_id UUID
  REFERENCES controlled_proof_runs(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_jobs_controlled_proof_run
  ON scan_jobs(controlled_proof_run_id)
  WHERE controlled_proof_run_id IS NOT NULL;
