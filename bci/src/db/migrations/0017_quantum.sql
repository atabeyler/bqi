-- Quantum Compute Gateway support (spec section 5-8, 17-19). Quantum is
-- opt-in per organization (section 7: "Default: LOCAL / CLASSICAL. Quantum
-- explicit policy ile etkinleşsin.") and data-classification gated for any
-- EXTERNAL provider (section 17) -- local providers (classical,
-- quantum-inspired, the local simulator) never leave the machine, so
-- max_external_data_classification only ever gates ibm_quantum.

CREATE TABLE IF NOT EXISTS quantum_policies (
  org_id                          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  allow_quantum_simulator         BOOLEAN NOT NULL DEFAULT false,
  allow_quantum_hardware          BOOLEAN NOT NULL DEFAULT false,
  max_external_data_classification TEXT NOT NULL DEFAULT 'PUBLIC',
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quantum_policies_classification_check
    CHECK (max_external_data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'))
);

-- One row per provider ATTEMPT (classical/quantum-inspired/simulator/
-- hardware) for one submitted problem -- benchmark_id groups the attempts
-- that were run against the same problem instance for comparison.
CREATE TABLE IF NOT EXISTS quantum_jobs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by           UUID NOT NULL REFERENCES users(id),
  benchmark_id           UUID NOT NULL,
  workload_source        TEXT NOT NULL,
  algorithm              TEXT,
  provider               TEXT NOT NULL,
  mode                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  qubits                 INTEGER,
  shots                  INTEGER,
  circuit_depth          INTEGER,
  fallback_reason        TEXT,
  result                 JSONB,
  input_hash             TEXT NOT NULL,
  output_hash            TEXT,
  environment_fingerprint TEXT NOT NULL,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  CONSTRAINT quantum_jobs_status_check CHECK (status IN ('SUBMITTED', 'COMPLETED', 'FAILED')),
  CONSTRAINT quantum_jobs_mode_check CHECK (mode IN ('CLASSICAL', 'QUANTUM_INSPIRED', 'QUANTUM_SIMULATOR', 'QUANTUM_HARDWARE'))
);

CREATE TABLE IF NOT EXISTS quantum_benchmarks (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workload_source TEXT NOT NULL,
  results         JSONB NOT NULL,
  verdict         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quantum_benchmarks_verdict_check
    CHECK (verdict IN ('QUANTUM_BENEFIT_OBSERVED', 'NO_QUANTUM_ADVANTAGE_DEMONSTRATED'))
);

CREATE INDEX IF NOT EXISTS idx_quantum_jobs_org_id ON quantum_jobs(org_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_quantum_jobs_benchmark_id ON quantum_jobs(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_quantum_benchmarks_org_id ON quantum_benchmarks(org_id, created_at DESC);
