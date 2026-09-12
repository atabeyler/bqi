-- Real per-job, per-engine execution options -- today used only by
-- http-fuzz's optional `plan` (an externally-proposed Smart Fuzz strategy,
-- e.g. from BQI's bciFuzzAdvisor.ts), threaded through
-- analysisPipeline.js -> scanExecution.js -> adapter.execute(). Deliberately
-- NOT a place for credentials (an auth header/token): this column is
-- persisted, logged in audit metadata, and returned from GET /scans/:id,
-- none of which secret material belongs in. Nullable -- every existing job
-- and every caller that never sends engineOptions is unaffected.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS engine_options JSONB;
