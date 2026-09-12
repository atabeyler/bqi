-- Real per-optimization-run compute-method provenance. recommended_mode is
-- what executionPolicy.js's real fallback chain resolves to with no
-- preference given (BCI's own recommendation); selected_mode is what the
-- caller asked to start the chain from (nullable -- every existing caller
-- of POST /quantum/remediation-optimize that never sends preferredMode
-- keeps behaving exactly as before, recommended_mode === actual_mode);
-- actual_mode is what really executed; fallback_reason is populated only
-- when actual_mode differs from selected_mode, carrying the real reason
-- (policy/health/size) executionPolicy.js's chain already computes -- never
-- fabricated after the fact.
ALTER TABLE quantum_benchmarks ADD COLUMN IF NOT EXISTS scan_job_id UUID REFERENCES scan_jobs(id);
ALTER TABLE quantum_benchmarks ADD COLUMN IF NOT EXISTS recommended_mode TEXT;
ALTER TABLE quantum_benchmarks ADD COLUMN IF NOT EXISTS selected_mode TEXT;
ALTER TABLE quantum_benchmarks ADD COLUMN IF NOT EXISTS actual_mode TEXT;
ALTER TABLE quantum_benchmarks ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

-- NOT_APPLICABLE is genuinely distinct from NO_QUANTUM_ADVANTAGE_DEMONSTRATED:
-- the latter means the benchmark ran and classical matched or beat quantum;
-- NOT_APPLICABLE means there was no optimization problem to run at all
-- (zero open, risk-scored findings in scope) -- these must never be
-- conflated into one "quantum didn't help" bucket.
ALTER TABLE quantum_benchmarks DROP CONSTRAINT quantum_benchmarks_verdict_check;
ALTER TABLE quantum_benchmarks ADD CONSTRAINT quantum_benchmarks_verdict_check
  CHECK (verdict IN ('QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD', 'NO_QUANTUM_ADVANTAGE_DEMONSTRATED', 'NOT_APPLICABLE'));
