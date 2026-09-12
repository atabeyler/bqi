-- M5: hybrid engine adapters. Third-party scanners are registered here as
-- interchangeable sensors (spec: "araç sonuç üretir; nihai değerlendirmeyi
-- BCI yapar") -- nothing downstream trusts an engine's own severity/verdict
-- directly; that's the job of Normalization/Correlation/Verification (M6-M7).

CREATE TABLE IF NOT EXISTS engine_registry (
  id                      TEXT PRIMARY KEY, -- e.g. 'trivy', 'osv-scanner', 'semgrep', 'nuclei', 'naabu'
  name                    TEXT NOT NULL,
  intrusiveness           TEXT NOT NULL, -- the minimum authorized scan class this engine requires to run
  supported_target_types  TEXT[] NOT NULL DEFAULT '{}',
  supported_analysis_types TEXT[] NOT NULL DEFAULT '{}',
  license                 TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_registry_intrusiveness_check
    CHECK (intrusiveness IN ('PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'))
);

CREATE TABLE IF NOT EXISTS engine_health (
  engine_id       TEXT PRIMARY KEY REFERENCES engine_registry(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'OFFLINE',
  version         TEXT,
  detail          TEXT,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_health_status_check CHECK (status IN ('HEALTHY', 'DEGRADED', 'OFFLINE'))
);

-- Engine output before normalization (M6) -- raw, engine-native shape,
-- kept as-is so nothing is lost/reshaped before correlation gets a look.
CREATE TABLE IF NOT EXISTS raw_observations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id      UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,
  engine_id   TEXT NOT NULL REFERENCES engine_registry(id),
  target      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_observations_org_id ON raw_observations(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_observations_job_id ON raw_observations(job_id);
