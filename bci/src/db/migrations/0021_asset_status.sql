-- Asset lifecycle: archive, never a hard DELETE. An asset row has no
-- inbound FK from scan_jobs/findings/reports -- those are linked to an
-- asset only by matching asset_identifiers.value = target (see
-- services/risk.js, coverageScore.js, remediationOptimizer.js,
-- securityGraph.js), so deleting the assets row would CASCADE-delete its
-- asset_identifiers and permanently sever the one thing tying historical
-- scans/findings back to it, with no way to reconstruct that link
-- afterward. Archiving keeps every identifier and every past scan/finding
-- fully intact and queryable; only the default inventory view hides it.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE assets
  ADD CONSTRAINT assets_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED'));

CREATE INDEX IF NOT EXISTS idx_assets_org_status ON assets(org_id, status);
