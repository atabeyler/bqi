import { query } from '../db/client.js';
import { listIntrusiveModules, selectApplicableModules } from '../engines/intrusive/registry.js';

export async function loadTargetFindings(orgId, target) {
  const { rows } = await query(
    `SELECT f.id, f.title, f.category, f.location, f.target, f.verification_status,
            f.confidence_score, f.priority, f.risk_score,
            src.engine_id AS source_engine, src.rule_id, src.engine_severity, src.evidence
       FROM findings f
       LEFT JOIN LATERAL (
         SELECT fs.engine_id, no.rule_id, no.engine_severity, no.evidence
           FROM finding_sources fs
           JOIN normalized_observations no ON no.id = fs.normalized_observation_id
          WHERE fs.finding_id = f.id
          ORDER BY no.detected_at DESC LIMIT 1
       ) src ON true
      WHERE f.org_id = $1 AND f.target = $2
      ORDER BY f.created_at DESC LIMIT 50`,
    [orgId, target]
  );
  return rows.map((row) => ({
    id: row.id, title: row.title, category: row.category, location: row.location,
    target: row.target, verificationStatus: row.verification_status,
    confidenceScore: row.confidence_score, priority: row.priority, riskScore: row.risk_score,
    sourceEngine: row.source_engine, rule: row.rule_id, engineSeverity: row.engine_severity,
    evidence: row.evidence || {},
  }));
}

export async function loadCanonicalPriorFindings(orgId, target, ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT f.id, f.title, f.location, f.priority,
            src.engine_id AS source_engine, src.rule_id, src.engine_severity, src.evidence
       FROM findings f
       LEFT JOIN LATERAL (
         SELECT fs.engine_id, no.rule_id, no.engine_severity, no.evidence
           FROM finding_sources fs
           JOIN normalized_observations no ON no.id = fs.normalized_observation_id
          WHERE fs.finding_id = f.id ORDER BY no.detected_at DESC LIMIT 1
       ) src ON true
      WHERE f.org_id = $1 AND f.target = $2 AND f.id = ANY($3::uuid[])`,
    [orgId, target, ids]
  );
  const byId = new Map(rows.map((row) => [row.id, {
    id: row.id, title: row.title, location: row.location, evidence: row.evidence || {},
    sourceEngine: row.source_engine, rule: row.rule_id, severity: row.engine_severity || row.priority,
  }]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function buildIntrusivePlan(target, priorFindings = [], discovery = {}) {
  const context = { target, priorFindings, ...discovery };
  const applicable = new Set(selectApplicableModules(context).map((module) => module.id));
  const modules = listIntrusiveModules().map((module) => ({
    id: module.id,
    family: module.family,
    name: module.name,
    description: module.description,
    status: module.status,
    requiredIntrusiveness: module.requiredIntrusiveness,
    blockedOn: module.blockedOn ?? null,
    applicable: module.status === 'IMPLEMENTED' && applicable.has(module.id),
    applicability: module.id === 'FINDING_REPRODUCIBILITY_VERIFICATION' ? 'SELECTED_PRIOR_FINDING' : module.id === 'OPENAPI_SCHEMA_BEHAVIOR' ? 'DISCOVERED_OPENAPI' : module.id === 'WEBSOCKET_API_PROTOCOL' ? 'WEBSOCKET_LIKE_PATH' : 'HTTP_TARGET',
    requiredEvidence: module.id === 'FINDING_REPRODUCIBILITY_VERIFICATION' ? 'At least one persisted prior finding' : module.id === 'OPENAPI_SCHEMA_BEHAVIOR' ? 'A discoverable OpenAPI document' : 'Reachable HTTP target',
    source: 'BCI_NATIVE_REGISTRY',
  }));
  return {
    modules,
    baseModuleIds: modules.filter((module) => module.applicable).map((module) => module.id),
    selectedPriorFindings: priorFindings,
    summary: {
      total: modules.length,
      implemented: modules.filter((module) => module.status === 'IMPLEMENTED').length,
      planned: modules.filter((module) => module.status === 'PLANNED').length,
      applicable: modules.filter((module) => module.applicable).length,
    },
  };
}
