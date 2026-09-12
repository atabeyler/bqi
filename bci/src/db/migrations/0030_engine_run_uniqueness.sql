-- One canonical execution status per engine/job. Older retries could append
-- duplicate COMPLETED rows when a later pipeline stage failed.
DELETE FROM scan_job_engine_runs older
USING scan_job_engine_runs newer
WHERE older.job_id = newer.job_id
  AND older.engine_id = newer.engine_id
  AND (older.started_at, older.id) < (newer.started_at, newer.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_job_engine_runs_job_engine
  ON scan_job_engine_runs(job_id, engine_id);
