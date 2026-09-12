-- Report removal is soft so report content/hash and audit references remain
-- verifiable. Language records which locale shaped user-facing report text.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_language_check;
ALTER TABLE reports ADD CONSTRAINT reports_language_check CHECK (language IN ('en', 'tr', 'fr', 'de', 'ar'));

CREATE INDEX IF NOT EXISTS idx_reports_active_org_created
  ON reports(org_id, created_at DESC) WHERE archived_at IS NULL;
