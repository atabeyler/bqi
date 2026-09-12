-- AI/agent/MCP intelligence extends decision evidence and graph projection.
-- It does not modify BCI authentication, authorization, RBAC, permissions,
-- policies, scopes, sessions, gateways, or tenant isolation.

ALTER TABLE attack_technique_mappings
  ADD COLUMN IF NOT EXISTS framework TEXT NOT NULL DEFAULT 'ATTACK',
  ADD COLUMN IF NOT EXISTS catalog_version TEXT;

CREATE INDEX IF NOT EXISTS idx_attack_technique_mappings_framework
  ON attack_technique_mappings(org_id, framework, technique_id);

-- New simulations remain target-system posture simulations. They do not
-- grant, revoke, or otherwise change BCI permissions.
ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_scenario_type_check;
ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_scenario_type_check CHECK (
  scenario_type IN (
    'PATCH_CVE', 'ENABLE_MFA', 'REMOVE_PERMISSION', 'REMOVE_INTERNET_EXPOSURE',
    'ADD_SEGMENTATION', 'REQUIRE_HUMAN_APPROVAL', 'DISABLE_MCP_TOOL',
    'ROTATE_WORKLOAD_IDENTITY'
  )
);
