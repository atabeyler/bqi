-- Real per-job engine selection provenance: what BCI's planner recommended
-- vs. what the caller actually selected to run (a validated subset of the
-- recommendation -- never an engine outside it, see jobQueue.js#enqueueScan).
-- Both nullable so every pre-existing job (and any caller that never sends
-- selectedEngineIds, i.e. the existing quick-scan path) is untouched --
-- analysisPipeline.js treats a null/empty selected_engine_ids exactly like
-- "run the full recommended plan", identical to today's behavior.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS recommended_engine_ids TEXT[];
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS selected_engine_ids TEXT[];
