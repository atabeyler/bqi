-- Keep report archive and deletion as distinct lifecycle operations.
-- Deleted reports are tombstoned so audit references remain valid while
-- report content and integrity material are removed from product history.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reports_org_deleted
  ON reports(org_id, deleted_at, created_at DESC);
