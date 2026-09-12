-- Historical posture state and decision-layer facts. This migration only
-- adds cyber-analysis data; it does not alter BCI authorization or tenancy.

CREATE TABLE IF NOT EXISTS snapshot_entity_states (
  snapshot_id      UUID NOT NULL REFERENCES posture_snapshots(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL,
  external_key     TEXT NOT NULL,
  label            TEXT NOT NULL,
  attributes       JSONB NOT NULL DEFAULT '{}',
  fingerprint      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, entity_type, external_key)
);

CREATE TABLE IF NOT EXISTS snapshot_relationship_states (
  snapshot_id       UUID NOT NULL REFERENCES posture_snapshots(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL,
  source_key        TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_key        TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  evidence          JSONB NOT NULL DEFAULT '{}',
  fingerprint       TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, source_type, source_key, target_type, target_key, relationship_type)
);

CREATE TABLE IF NOT EXISTS snapshot_control_states (
  snapshot_id      UUID NOT NULL REFERENCES posture_snapshots(id) ON DELETE CASCADE,
  external_key     TEXT NOT NULL,
  control_type     TEXT NOT NULL,
  status           TEXT NOT NULL,
  effectiveness    NUMERIC NOT NULL,
  evidence         JSONB NOT NULL DEFAULT '{}',
  fingerprint      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, external_key)
);

CREATE TABLE IF NOT EXISTS control_entity_links (
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  control_id         UUID NOT NULL REFERENCES security_controls(id) ON DELETE CASCADE,
  entity_id          UUID NOT NULL REFERENCES cyber_entities(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, control_id, entity_id)
);

CREATE TABLE IF NOT EXISTS attack_technique_mappings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id         UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  technique_id       TEXT NOT NULL,
  evidence_id        UUID REFERENCES decision_evidence(id) ON DELETE SET NULL,
  confidence         INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  rationale          TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, finding_id, technique_id)
);

CREATE TABLE IF NOT EXISTS remediation_dependencies (
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  remediation_id            UUID NOT NULL REFERENCES remediations(id) ON DELETE CASCADE,
  depends_on_remediation_id UUID NOT NULL REFERENCES remediations(id) ON DELETE CASCADE,
  reason                    TEXT NOT NULL,
  PRIMARY KEY (org_id, remediation_id, depends_on_remediation_id),
  CHECK (remediation_id <> depends_on_remediation_id)
);

CREATE TABLE IF NOT EXISTS decision_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by       UUID NOT NULL REFERENCES users(id),
  model_version      INTEGER NOT NULL,
  input_hash         TEXT NOT NULL,
  recommendations    JSONB NOT NULL,
  total_risk_before  NUMERIC NOT NULL,
  estimated_risk_after NUMERIC NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by       UUID NOT NULL REFERENCES users(id),
  scenario_type      TEXT NOT NULL CHECK (scenario_type IN ('PATCH_CVE', 'ENABLE_MFA', 'REMOVE_PERMISSION', 'REMOVE_INTERNET_EXPOSURE', 'ADD_SEGMENTATION')),
  scenario           JSONB NOT NULL,
  graph_snapshot_hash TEXT NOT NULL,
  result             JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshot_entity_states_key ON snapshot_entity_states(entity_type, external_key);
CREATE INDEX IF NOT EXISTS idx_snapshot_control_states_key ON snapshot_control_states(external_key);
CREATE INDEX IF NOT EXISTS idx_control_entity_links_entity ON control_entity_links(entity_id);
CREATE INDEX IF NOT EXISTS idx_attack_technique_mappings_finding ON attack_technique_mappings(finding_id);
CREATE INDEX IF NOT EXISTS idx_decision_runs_org_created ON decision_runs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_simulation_runs_org_created ON simulation_runs(org_id, created_at DESC);
