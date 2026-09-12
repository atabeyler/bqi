-- M7: Correlation & Verification. This is the Observation != Finding
-- boundary (spec section 15): a Finding is BCI's own claim, built from one
-- or more normalized_observations, never a 1:1 passthrough of what a single
-- engine reported.

CREATE TABLE IF NOT EXISTS findings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  correlation_key       TEXT NOT NULL, -- see services/correlation.js for how this is derived
  category              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  cve_ids               TEXT[] NOT NULL DEFAULT '{}',
  cwe_ids               TEXT[] NOT NULL DEFAULT '{}',
  component             TEXT,
  component_version     TEXT,
  location              TEXT,
  target                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'NEW',
  verification_status   TEXT NOT NULL DEFAULT 'UNVERIFIED',
  confidence_score      INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT findings_status_check CHECK (status IN (
    'NEW', 'CONFIRMED', 'ASSIGNED', 'IN_REMEDIATION', 'READY_FOR_VERIFICATION',
    'VERIFIED_FIXED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'MITIGATED', 'DEFERRED'
  )),
  CONSTRAINT findings_verification_status_check CHECK (verification_status IN (
    'UNVERIFIED', 'LIKELY', 'CONFIRMED', 'MANUAL_REVIEW_REQUIRED', 'REJECTED'
  )),
  CONSTRAINT findings_confidence_range CHECK (confidence_score BETWEEN 0 AND 100),
  -- One org can only ever have one live Finding per correlation key -- this
  -- is what makes correlation idempotent: re-running it never creates
  -- duplicate Findings for the same underlying issue.
  UNIQUE (org_id, correlation_key)
);

-- Which normalized_observations (and therefore which engines) contributed
-- to a Finding -- spec section 22's `sources = [BCI Native, Nuclei, ZAP]`.
CREATE TABLE IF NOT EXISTS finding_sources (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id               UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  normalized_observation_id UUID NOT NULL REFERENCES normalized_observations(id) ON DELETE CASCADE,
  engine_id                TEXT NOT NULL REFERENCES engine_registry(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finding_id, normalized_observation_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_org_id ON findings(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finding_sources_finding_id ON finding_sources(finding_id);
