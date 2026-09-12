-- User-visible deletion for scan and Controlled Proof histories. Rows are
-- tombstoned (and result payloads redacted) so the append-only audit ledger
-- can prove who deleted a record without exposing it in product history.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE controlled_proof_runs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scan_jobs_org_deleted ON scan_jobs(org_id, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_deleted ON controlled_proof_runs(org_id, deleted_at, created_at DESC);
