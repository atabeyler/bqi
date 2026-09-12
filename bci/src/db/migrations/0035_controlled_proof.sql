-- Controlled Proof stores non-destructive technical impact validation.
-- AuthN/AuthZ/RBAC/permissions/policies/scopes/sessions
-- and tenant-isolation structures are deliberately untouched.
CREATE TABLE IF NOT EXISTS controlled_proof_runs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id              UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target                     TEXT NOT NULL,
  normalized_target          TEXT NOT NULL,
  finding_id                 UUID REFERENCES findings(id) ON DELETE SET NULL,
  impact_evidence_id         UUID REFERENCES decision_evidence(id) ON DELETE SET NULL,
  proof_id                   TEXT NOT NULL UNIQUE,
  proof_type                 TEXT NOT NULL CHECK (proof_type = 'WEB_CONTENT_IMPACT'),
  status                     TEXT NOT NULL CHECK (status IN ('ANALYZING', 'READY', 'FAILED', 'CANCELLED')),
  security_impact_status     TEXT CHECK (security_impact_status IN ('NO_PATH', 'POTENTIAL', 'VERIFIED_IMPACT_PATH')),
  security_validator_id      TEXT,
  security_evidence          JSONB NOT NULL DEFAULT '{}',
  started_at                 TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  duration_ms                INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  validation_token_hash      TEXT,
  evidence_hash              TEXT,
  persistent_modification    BOOLEAN NOT NULL DEFAULT false CHECK (persistent_modification = false),
  failure_reason             TEXT,
  archived_at                TIMESTAMPTZ,
  provenance                 JSONB NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_created ON controlled_proof_runs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_security ON controlled_proof_runs(org_id, security_impact_status);
CREATE INDEX IF NOT EXISTS idx_controlled_proof_runs_org_archive ON controlled_proof_runs(org_id, archived_at, created_at DESC);
