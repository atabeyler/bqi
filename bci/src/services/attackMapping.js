import { query } from '../db/client.js';
import { ATLAS_BY_AI_RULE } from '../intelligence/aiSecurity.js';

// Conservative, evidence-gated ATT&CK mappings. A mapping is emitted only
// when a normalized observation contains one of these exact deterministic
// rule IDs; titles/categories alone are never used as evidence.
const TECHNIQUE_BY_RULE = Object.freeze({
  'BCI-CLOUD-PUBLIC': { techniqueId: 'T1190', framework: 'ATTACK', rationale: 'Observed public exposure can provide an externally reachable initial-access surface.' },
  'BCI-IAM-EXCESSIVE': { techniqueId: 'T1078', rationale: 'Observed excessive privileges increase the impact of valid-account abuse.' },
  'BCI-IAM-MFA': { techniqueId: 'T1078', rationale: 'Observed lack of MFA weakens protection against valid-account abuse.' },
  'BCI-IAM-TRUST': { techniqueId: 'T1199', rationale: 'Observed external trust relationship creates a trusted-relationship path.' },
  'BCI-K8S-PRIVILEGED': { techniqueId: 'T1611', rationale: 'Observed privileged workload is direct evidence relevant to escape-to-host risk.' },
  'BCI-K8S-RBAC': { techniqueId: 'T1078', rationale: 'Observed broad cluster permissions increase valid-account abuse impact.' },
  'BCI-API-AUTHZ': { techniqueId: 'T1190', rationale: 'Observed API authorization failure exposes a public-facing application path.' },
  'BCI-CICD-UNSAFE': { techniqueId: 'T1195.002', rationale: 'Observed unsafe pipeline execution is relevant to software supply-chain compromise.' },
  'BCI-CICD-SECRET': { techniqueId: 'T1552.001', rationale: 'Observed pipeline secret exposure is relevant to credentials in files.' },
  'BCI-THREAT-MATCH': { techniqueId: 'T1588', rationale: 'Observed threat-intelligence match provides evidence of an adversary-resource relationship.' },
});

const VERSIONED_TECHNIQUE_BY_RULE = Object.freeze({ ...TECHNIQUE_BY_RULE, ...ATLAS_BY_AI_RULE });

export function mapRuleToTechnique(ruleId) {
  const mapping = VERSIONED_TECHNIQUE_BY_RULE[ruleId];
  return mapping ? { framework: 'ATTACK', catalogVersion: null, ...mapping } : null;
}

export async function mapEvidenceBackedTechniques(orgId, findingIds) {
  if (!findingIds?.length) return [];
  const { rows: sources } = await query(
    `SELECT DISTINCT fs.finding_id, no.rule_id, no.target, no.category
       FROM finding_sources fs
       JOIN normalized_observations no ON no.id = fs.normalized_observation_id
       JOIN findings f ON f.id = fs.finding_id
      WHERE f.org_id = $1 AND fs.finding_id = ANY($2)`,
    [orgId, findingIds]
  );
  const inserted = [];
  for (const source of sources) {
    const mapping = mapRuleToTechnique(source.rule_id);
    if (!mapping) continue;
    const { rows: evidenceRows } = await query(
      `SELECT id FROM decision_evidence
        WHERE org_id = $1 AND target = $2 AND evidence_type = $3
        ORDER BY observed_at DESC LIMIT 1`,
      [orgId, source.target, source.category]
    );
    // Posture rule mappings require the separately persisted evidence row;
    // without it the mapping remains absent rather than inferred.
    if (!evidenceRows[0]) continue;
    const { rows } = await query(
      `INSERT INTO attack_technique_mappings (
         org_id, finding_id, technique_id, evidence_id, confidence, rationale, framework, catalog_version
       ) VALUES ($1,$2,$3,$4,80,$5,$6,$7)
       ON CONFLICT (org_id, finding_id, technique_id) DO UPDATE SET
         evidence_id = EXCLUDED.evidence_id, confidence = EXCLUDED.confidence,
         rationale = EXCLUDED.rationale, framework = EXCLUDED.framework,
         catalog_version = EXCLUDED.catalog_version
       RETURNING id, finding_id, technique_id, framework, catalog_version`,
      [orgId, source.finding_id, mapping.techniqueId, evidenceRows[0].id, mapping.rationale, mapping.framework, mapping.catalogVersion]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}
