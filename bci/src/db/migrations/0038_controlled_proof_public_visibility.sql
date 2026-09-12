-- Public visibility is kept separate from security-impact validation. The
-- provider secret is environment-only; only non-secret resource identifiers
-- and hashed evidence are persisted.
ALTER TABLE controlled_proof_runs
  ADD COLUMN IF NOT EXISTS public_proof_status TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN IF NOT EXISTS public_validator_id TEXT,
  ADD COLUMN IF NOT EXISTS public_visibility_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_evidence JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS public_evidence_hash TEXT,
  ADD COLUMN IF NOT EXISTS public_failure_reason TEXT;

ALTER TABLE controlled_proof_runs
  DROP CONSTRAINT IF EXISTS controlled_proof_runs_public_proof_status_check;
ALTER TABLE controlled_proof_runs
  ADD CONSTRAINT controlled_proof_runs_public_proof_status_check
  CHECK (public_proof_status IN ('UNAVAILABLE', 'AVAILABLE', 'ACTIVATING', 'ACTIVE', 'VERIFIED', 'EXPIRED', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_public
  ON controlled_proof_runs(org_id, public_proof_status, public_expires_at);
