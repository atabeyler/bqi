-- Real, append-only point-in-time history for an asset's risk posture --
-- previously nothing recorded this at all, so an asset's "history" could
-- only ever be reconstructed (or worse, guessed) from the live state of
-- findings, which is exactly what spec section 11 forbids fabricating.
-- One row is written per real event (a scan actually completing for a
-- target matching this asset -- see services/assetRiskHistory.js), never
-- on a mere read/page view, so this is a true timeline, not a cache.
CREATE TABLE IF NOT EXISTS asset_risk_snapshots (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id             UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  scan_job_id          UUID REFERENCES scan_jobs(id),
  risk_score           INTEGER,
  open_finding_count   INTEGER NOT NULL,
  priority_breakdown   JSONB NOT NULL DEFAULT '{}',
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_risk_snapshots_asset_id ON asset_risk_snapshots(asset_id, computed_at DESC);
