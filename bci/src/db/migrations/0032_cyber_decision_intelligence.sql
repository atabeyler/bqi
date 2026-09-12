-- Cyber Decision Intelligence foundation. These tables model target-system
-- posture and evidence only; BCI identity, authorization, scopes, roles,
-- permissions, policies, and tenant isolation are deliberately untouched.

CREATE TABLE IF NOT EXISTS posture_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scan_job_id      UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,
  source           TEXT NOT NULL,
  schema_version   TEXT NOT NULL,
  target           TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  collected_at     TIMESTAMPTZ NOT NULL,
  payload_hash     TEXT NOT NULL,
  entity_count     INTEGER NOT NULL DEFAULT 0,
  relationship_count INTEGER NOT NULL DEFAULT 0,
  finding_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, payload_hash)
);

CREATE TABLE IF NOT EXISTS cyber_entities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL,
  external_key     TEXT NOT NULL,
  label            TEXT NOT NULL,
  provider         TEXT,
  region           TEXT,
  attributes       JSONB NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity_type, external_key)
);

CREATE TABLE IF NOT EXISTS cyber_relationships (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_entity_id   UUID NOT NULL REFERENCES cyber_entities(id) ON DELETE CASCADE,
  target_entity_id   UUID NOT NULL REFERENCES cyber_entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  evidence           JSONB NOT NULL DEFAULT '{}',
  confidence         INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  first_seen_at      TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, source_entity_id, target_entity_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS security_controls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_key       TEXT NOT NULL,
  control_type       TEXT NOT NULL,
  label              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('EFFECTIVE', 'PARTIAL', 'INEFFECTIVE', 'UNKNOWN')),
  effectiveness      NUMERIC NOT NULL DEFAULT 0 CHECK (effectiveness BETWEEN 0 AND 1),
  evidence           JSONB NOT NULL DEFAULT '{}',
  observed_at        TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, external_key)
);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot_id        UUID REFERENCES posture_snapshots(id) ON DELETE SET NULL,
  evidence_key       TEXT NOT NULL,
  source             TEXT NOT NULL,
  engine_id          TEXT,
  target             TEXT NOT NULL,
  evidence_type      TEXT NOT NULL,
  summary            TEXT NOT NULL,
  redacted_payload   JSONB NOT NULL DEFAULT '{}',
  confidence         INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('UNVERIFIED', 'OBSERVED', 'CORROBORATED', 'REJECTED')),
  observed_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS idx_posture_snapshots_org_target ON posture_snapshots(org_id, target, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_cyber_entities_org_type ON cyber_entities(org_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_cyber_relationships_org_source ON cyber_relationships(org_id, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_cyber_relationships_org_target ON cyber_relationships(org_id, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_security_controls_org_type ON security_controls(org_id, control_type);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_org_target ON decision_evidence(org_id, target, observed_at DESC);
