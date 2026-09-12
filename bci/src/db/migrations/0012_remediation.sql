-- M11: Remediation & Verify.

CREATE TABLE IF NOT EXISTS remediations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id       UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  assignee_user_id UUID REFERENCES users(id),
  recommendation   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'OPEN',
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remediations_status_check CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE'))
);

-- BCI Verify (spec section 35): a targeted, safe re-check of one specific
-- Finding rather than a full re-scan. One append-only row per attempt --
-- an INCONCLUSIVE result is itself useful history, not something to overwrite.
CREATE TABLE IF NOT EXISTS verification_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id    UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  triggered_by  UUID NOT NULL REFERENCES users(id),
  result        TEXT NOT NULL,
  detail        TEXT,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT verification_runs_result_check CHECK (result IN ('FIX_VERIFIED', 'VULNERABILITY_REMAINS', 'INCONCLUSIVE'))
);

CREATE INDEX IF NOT EXISTS idx_remediations_finding_id ON remediations(finding_id);
CREATE INDEX IF NOT EXISTS idx_verification_runs_finding_id ON verification_runs(finding_id, run_at DESC);
