-- Missed in 0026 (which added the equivalent columns to quantum_benchmarks
-- but not the scan_jobs side): the Quantum wizard step's own choice is
-- made at scan-creation time (before findings exist), stored here, and
-- only actually consumed later once remediation-optimize genuinely runs
-- against this job's findings (services/jobQueue.js#enqueueScan,
-- quantum/benchmark.js). Both nullable -- a job created before this
-- existed, or by any caller that never sends selectedComputeMode, is
-- untouched.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS recommended_compute_mode TEXT;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS selected_compute_mode TEXT;
