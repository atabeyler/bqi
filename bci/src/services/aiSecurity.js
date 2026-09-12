import { query } from '../db/client.js';

export const AI_SECURITY_REPORT_VERSION = 1;

const AI_ENTITY_TYPES = Object.freeze([
  'AI_APPLICATION', 'AI_AGENT', 'MODEL', 'MODEL_PROVIDER', 'AI_ENDPOINT',
  'MODEL_ENDPOINT', 'AGENT_TOOL', 'AGENT_MEMORY', 'VECTOR_STORE', 'RAG_PIPELINE',
  'MULTI_AGENT_CHANNEL', 'MCP_SERVER', 'MCP_CLIENT', 'MCP_TOOL', 'MCP_RESOURCE',
  'WORKLOAD_IDENTITY', 'SERVICE_IDENTITY', 'AGENT_IDENTITY', 'TRUST_DOMAIN',
  'SVID', 'DATASET', 'AI_FRAMEWORK',
]);

export async function buildAiSecurityReport(orgId) {
  const [{ rows: entities }, { rows: relationships }, { rows: findings }, { rows: atlasMappings }] = await Promise.all([
    query(
      `SELECT id, entity_type, external_key, label, provider, region, attributes, first_seen_at, last_seen_at
         FROM cyber_entities WHERE org_id = $1 AND entity_type = ANY($2)
        ORDER BY entity_type, external_key`,
      [orgId, AI_ENTITY_TYPES]
    ),
    query(
      `SELECT source.entity_type AS source_type, source.external_key AS source_key,
              target.entity_type AS target_type, target.external_key AS target_key,
              cr.relationship_type, cr.confidence, cr.evidence
         FROM cyber_relationships cr
         JOIN cyber_entities source ON source.id = cr.source_entity_id
         JOIN cyber_entities target ON target.id = cr.target_entity_id
        WHERE cr.org_id = $1 AND (source.entity_type = ANY($2) OR target.entity_type = ANY($2))
        ORDER BY source.external_key, cr.relationship_type, target.external_key`,
      [orgId, AI_ENTITY_TYPES]
    ),
    query(
      `SELECT f.id, f.target, f.category, f.title, f.status, f.verification_status,
              f.confidence_score, f.risk_score, f.risk_breakdown, f.risk_model_version,
              no.rule_id, de.id AS evidence_id, de.source AS evidence_source,
              de.observed_at
         FROM findings f
         JOIN finding_sources fs ON fs.finding_id = f.id
         JOIN normalized_observations no ON no.id = fs.normalized_observation_id
         LEFT JOIN decision_evidence de ON de.org_id = f.org_id AND de.target = f.target
              AND de.evidence_type = no.category
        WHERE f.org_id = $1 AND no.category = ANY($2)
        ORDER BY f.risk_score DESC NULLS LAST, f.id`,
      [orgId, ['AI_AGENT_SECURITY', 'MCP_SECURITY', 'AI_SUPPLY_CHAIN', 'WORKLOAD_IDENTITY']]
    ),
    query(
      `SELECT atm.finding_id, atm.technique_id, atm.framework, atm.catalog_version,
              atm.confidence, atm.rationale, atm.evidence_id
         FROM attack_technique_mappings atm
        WHERE atm.org_id = $1 AND atm.framework = 'ATLAS'
        ORDER BY atm.technique_id, atm.finding_id`,
      [orgId]
    ),
  ]);

  const inventory = Object.fromEntries(AI_ENTITY_TYPES.map((type) => [type, entities.filter((entity) => entity.entity_type === type).length]));
  return {
    reportVersion: AI_SECURITY_REPORT_VERSION,
    inventory,
    entities,
    relationships,
    findings,
    atlasMappings,
    graphChainCoverage: {
      desired: ['USER', 'AI_APPLICATION', 'AI_AGENT', 'MODEL', 'MCP_SERVER', 'MCP_TOOL', 'API', 'WORKLOAD_IDENTITY', 'CLOUD_RESOURCE', 'DATABASE', 'BUSINESS_SERVICE', 'CRITICAL_ASSET'],
      observedEntityTypes: [...new Set(entities.map((entity) => entity.entity_type))],
      inferredEdges: false,
    },
    evidencePolicy: 'Only persisted observations are included. Missing facts and AI-generated estimates are not converted into findings.',
  };
}

