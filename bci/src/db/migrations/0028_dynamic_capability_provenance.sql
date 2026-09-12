-- Canonical capability selection provenance for a scan. Actual execution is
-- recorded in scan_jobs.result only after engines really run.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS recommended_capability_ids TEXT[];
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS selected_capability_ids TEXT[];

-- Observation-level capability provenance. Nullable for historical rows.
ALTER TABLE normalized_observations ADD COLUMN IF NOT EXISTS capability_id TEXT;
