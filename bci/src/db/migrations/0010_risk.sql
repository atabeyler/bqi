-- M9: Risk / Priority / Security Score / Coverage Score. CVSS stays the
-- technical reference (spec section 26: "CVSS'yi değiştirme") -- risk_score
-- is BCI's own number built on top of it, never a replacement for it.

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS risk_score      INTEGER,
  ADD COLUMN IF NOT EXISTS risk_breakdown  JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS priority        TEXT,
  ADD COLUMN IF NOT EXISTS risk_model_version INTEGER;

ALTER TABLE findings
  ADD CONSTRAINT findings_risk_score_range CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  ADD CONSTRAINT findings_priority_check CHECK (priority IS NULL OR priority IN (
    'IMMEDIATE', '24_HOURS', 'HIGH_PRIORITY', 'PLANNED', 'MONITOR'
  ));

-- Point-in-time history: "Bu puan neden verildi?" (spec section 26) must
-- stay answerable even after the finding's live risk_score has since moved
-- on -- one append-only row per recompute, never updated in place.
CREATE TABLE IF NOT EXISTS risk_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id         UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  risk_score         INTEGER NOT NULL,
  priority           TEXT NOT NULL,
  breakdown          JSONB NOT NULL,
  risk_model_version INTEGER NOT NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_history_finding_id ON risk_history(finding_id, computed_at DESC);
