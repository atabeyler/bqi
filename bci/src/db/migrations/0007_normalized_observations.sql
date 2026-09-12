-- M6: Normalization. Every engine's raw, engine-native output (M5's
-- raw_observations) gets mapped into this one common shape. Nothing
-- downstream (Correlation, Verification, Risk) ever reads a raw_observations
-- row directly or trusts an engine's own severity string as BCI's own --
-- this table is the seam spec section 16 describes.

CREATE TABLE IF NOT EXISTS normalized_observations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  raw_observation_id    UUID NOT NULL REFERENCES raw_observations(id) ON DELETE CASCADE,
  job_id                UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,
  engine_id             TEXT NOT NULL REFERENCES engine_registry(id),
  engine_version        TEXT,
  rule_id               TEXT,
  target                TEXT NOT NULL,
  category              TEXT NOT NULL, -- SAST, SCA, SECRETS, IAC, WEB, API, NETWORK_DISCOVERY, ...
  title                 TEXT NOT NULL,
  description           TEXT,
  engine_severity        TEXT,   -- the engine's own severity label, kept verbatim for audit/explainability
  cve_ids               TEXT[] NOT NULL DEFAULT '{}',
  cwe_ids               TEXT[] NOT NULL DEFAULT '{}',
  cvss_vector           TEXT,
  cvss_score            NUMERIC,
  component             TEXT,
  component_version     TEXT,
  location              TEXT,   -- file path, URL, host:port, etc., engine-specific meaning
  evidence              JSONB NOT NULL DEFAULT '{}',
  "references"          TEXT[] NOT NULL DEFAULT '{}',
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_normalized_observations_org_id ON normalized_observations(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_normalized_observations_job_id ON normalized_observations(job_id);
CREATE INDEX IF NOT EXISTS idx_normalized_observations_raw_id ON normalized_observations(raw_observation_id);
