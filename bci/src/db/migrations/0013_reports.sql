-- M12: Reporting. Every report carries integrity metadata (spec section
-- 46) so it stays reproducible/explainable long after generation: which
-- BCI version and which risk/confidence/verification model versions
-- produced it, plus a content hash to detect later tampering.

CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_type     TEXT NOT NULL,
  generated_by    UUID NOT NULL REFERENCES users(id),
  content         JSONB NOT NULL,
  content_hash    TEXT NOT NULL, -- SHA-256 of `content`, canonical JSON
  bci_version     TEXT NOT NULL,
  model_versions  JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reports_type_check CHECK (report_type IN ('EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT'))
);

CREATE INDEX IF NOT EXISTS idx_reports_org_id ON reports(org_id, created_at DESC);
