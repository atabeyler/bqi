import { query } from '../db/client.js';

// BCI Risk Score v1 (spec section 26). CVSS remains the technical
// reference; this is BCI's own number built on top of it. Deterministic,
// versioned (RISK_MODEL_VERSION), and every input is kept in the returned
// breakdown so "why this score" is always answerable later, even after the
// live score has since moved on (risk_history keeps a snapshot per compute).
export const RISK_MODEL_VERSION = 3;

const CRITICALITY_MULTIPLIER = { LOW: 0.7, MEDIUM: 0.85, HIGH: 1.0, CRITICAL: 1.15 };
const DEFAULT_BASE_WITHOUT_CVSS = 50; // e.g. a SAST/secrets finding with no CVE at all

export function computeRiskScore({
  cvssScore,
  epssScore,
  kev,
  assetCriticality = 'MEDIUM',
  confidenceScore = 0,
  exploitability = 0,
  internetExposure = 0,
  attackPathReachability = 0,
  identityPrivilege = 0,
  businessImpact = 0,
  threatActivity = 0,
  compensatingControlEffectiveness = 0,
  agentPrivilege = 0,
  autonomousActionCapability = 0,
  toolPrivilege = 0,
  mcpExposure = 0,
  promptInjectionReachability = 0,
  sensitiveDataReachability = 0,
  workloadIdentityPrivilege = 0,
}) {
  const base = cvssScore != null ? cvssScore * 10 : DEFAULT_BASE_WITHOUT_CVSS;
  const epssBoost = epssScore != null ? epssScore * 20 : 0;
  const kevBoost = kev ? 25 : 0;
  const exploitabilityBoost = Math.max(0, Math.min(1, exploitability)) * 10;
  const exposureBoost = Math.max(0, Math.min(1, internetExposure)) * 15;
  const attackPathBoost = Math.max(0, Math.min(1, attackPathReachability)) * 15;
  const identityPrivilegeBoost = Math.max(0, Math.min(1, identityPrivilege)) * 10;
  const businessImpactBoost = Math.max(0, Math.min(1, businessImpact)) * 15;
  const threatActivityBoost = Math.max(0, Math.min(1, threatActivity)) * 15;
  // V3 inputs are accepted only from persisted posture evidence. Keeping
  // their defaults at zero preserves every V2 caller and score.
  const agentPrivilegeBoost = Math.max(0, Math.min(1, agentPrivilege)) * 8;
  const autonomousActionBoost = Math.max(0, Math.min(1, autonomousActionCapability)) * 10;
  const toolPrivilegeBoost = Math.max(0, Math.min(1, toolPrivilege)) * 8;
  const mcpExposureBoost = Math.max(0, Math.min(1, mcpExposure)) * 8;
  const promptInjectionBoost = Math.max(0, Math.min(1, promptInjectionReachability)) * 10;
  const sensitiveDataBoost = Math.max(0, Math.min(1, sensitiveDataReachability)) * 12;
  const workloadIdentityBoost = Math.max(0, Math.min(1, workloadIdentityPrivilege)) * 8;
  const criticalityMultiplier = CRITICALITY_MULTIPLIER[assetCriticality] ?? CRITICALITY_MULTIPLIER.MEDIUM;

  // A finding nobody has confirmed can still be shown, but it must never
  // read as equally risky as a confirmed one -- confidence 0 halves the
  // score, confidence 100 leaves it untouched. This is what keeps a
  // "CRITICAL severity, 20% confidence" finding from looking like an
  // immediate fire (spec section 24's worked example).
  const confidenceFactor = 0.5 + confidenceScore / 200;

  const preControls = (base + epssBoost + kevBoost + exploitabilityBoost + exposureBoost + attackPathBoost + identityPrivilegeBoost + businessImpactBoost + threatActivityBoost
    + agentPrivilegeBoost + autonomousActionBoost + toolPrivilegeBoost + mcpExposureBoost
    + promptInjectionBoost + sensitiveDataBoost + workloadIdentityBoost) * criticalityMultiplier;
  // Controls can reduce modeled exposure, but never erase it. The 60%
  // ceiling is explicit and deterministic; KEV still remains IMMEDIATE in
  // computePriority regardless of the numeric reduction.
  const normalizedControlEffectiveness = Math.max(0, Math.min(1, compensatingControlEffectiveness));
  const controlReduction = normalizedControlEffectiveness * 0.6;
  const score = Math.round(Math.max(0, Math.min(100, preControls * (1 - controlReduction) * confidenceFactor)));

  return {
    score,
    breakdown: {
      base, epssBoost, kevBoost, exploitabilityBoost, exposureBoost, attackPathBoost,
      identityPrivilegeBoost, businessImpactBoost, threatActivityBoost,
      agentPrivilegeBoost, autonomousActionBoost, toolPrivilegeBoost, mcpExposureBoost,
      promptInjectionBoost, sensitiveDataBoost, workloadIdentityBoost,
      criticalityMultiplier, confidenceFactor, controlReduction,
      assetCriticality, cvssScore, epssScore, kev, confidenceScore, exploitability,
      internetExposure, attackPathReachability, identityPrivilege, businessImpact,
      threatActivity, compensatingControlEffectiveness: normalizedControlEffectiveness,
      agentPrivilege, autonomousActionCapability, toolPrivilege, mcpExposure,
      promptInjectionReachability, sensitiveDataReachability, workloadIdentityPrivilege,
      evidencePolicy: 'persisted-observation-only; AI predictions are not evidence',
    },
  };
}

function numericPosture(value) {
  if (value === true || value === 'true' || value === 'PUBLIC' || value === 'CRITICAL') return 1;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

async function findDecisionInputs(orgId, target) {
  const { rows: entities } = await query(
    `SELECT id, entity_type, attributes FROM cyber_entities
      WHERE org_id = $1 AND (external_key = $2 OR label = $2)`,
    [orgId, target]
  );
  if (entities.length === 0) {
    return {
      exploitability: 0, internetExposure: 0, attackPathReachability: 0,
      identityPrivilege: 0, businessImpact: 0, threatActivity: 0,
      compensatingControlEffectiveness: 0, agentPrivilege: 0,
      autonomousActionCapability: 0, toolPrivilege: 0, mcpExposure: 0,
      promptInjectionReachability: 0, sensitiveDataReachability: 0,
      workloadIdentityPrivilege: 0,
    };
  }
  const entityIds = entities.map((entity) => entity.id);
  const { rows: controls } = await query(
    `SELECT sc.effectiveness FROM security_controls sc
       JOIN control_entity_links cel ON cel.control_id = sc.id AND cel.org_id = sc.org_id
      WHERE sc.org_id = $1 AND cel.entity_id = ANY($2) AND sc.status IN ('EFFECTIVE', 'PARTIAL')`,
    [orgId, entityIds]
  );
  const max = (keys, types = null) => Math.max(0, ...entities
    .filter((entity) => !types || types.includes(entity.entity_type))
    .flatMap((entity) => keys.map((key) => numericPosture((entity.attributes || {})[key]))));
  return {
    exploitability: max(['exploitability']),
    internetExposure: max(['internetExposed', 'public']),
    attackPathReachability: max(['attackPathReachability']),
    identityPrivilege: max(['identityPrivilege', 'excessivePrivilege', 'clusterAdmin'], ['IDENTITY', 'USER', 'ROLE', 'SERVICE_ACCOUNT']),
    businessImpact: max(['businessImpact']),
    threatActivity: max(['threatActivity', 'matched']),
    agentPrivilege: max(['agentPrivilege', 'excessivePrivilege'], ['AI_AGENT', 'AGENT_IDENTITY']),
    autonomousActionCapability: max(['autonomousAction', 'autonomousActionCapability']),
    toolPrivilege: max(['toolPrivilege', 'excessivePrivilege'], ['AGENT_TOOL', 'MCP_TOOL']),
    mcpExposure: max(['mcpExposure', 'shadow', 'unknown', 'internetExposed'], ['MCP_SERVER', 'MCP_CLIENT', 'MCP_TOOL', 'MCP_RESOURCE']),
    promptInjectionReachability: max(['promptInjectionReachability', 'indirectPromptInjectionReachable', 'untrustedInputReachable'], ['AI_APPLICATION', 'AI_ENDPOINT', 'MODEL_ENDPOINT']),
    sensitiveDataReachability: max(['sensitiveDataReachability', 'sensitiveContextReachable', 'sensitiveResourceExposed'], ['AI_APPLICATION', 'AI_AGENT', 'MCP_RESOURCE', 'MCP_SERVER']),
    workloadIdentityPrivilege: max(['workloadIdentityPrivilege', 'excessiveTrust'], ['WORKLOAD_IDENTITY', 'SERVICE_IDENTITY', 'AGENT_IDENTITY']),
    compensatingControlEffectiveness: controls.length
      ? Math.max(...controls.map((control) => Number(control.effectiveness)))
      : 0,
  };
}

// Action priority is not the same axis as the numeric score (spec section
// 27): a KEV-listed vulnerability is IMMEDIATE regardless of exactly how
// the 0-100 number landed, because active exploitation in the wild is a
// categorical fact, not a matter of degree.
export function computePriority(riskScore, kev) {
  if (kev || riskScore >= 90) return 'IMMEDIATE';
  if (riskScore >= 75) return '24_HOURS';
  if (riskScore >= 50) return 'HIGH_PRIORITY';
  if (riskScore >= 25) return 'PLANNED';
  return 'MONITOR';
}

async function findBestCveForFinding(finding) {
  if (!finding.cve_ids?.length) return null;
  const { rows } = await query(
    `SELECT * FROM vulnerabilities WHERE cve_id = ANY($1) ORDER BY cvss_score DESC NULLS LAST LIMIT 1`,
    [finding.cve_ids]
  );
  return rows[0] || null;
}

async function findAssetCriticality(orgId, target) {
  const { rows } = await query(
    `SELECT a.criticality FROM assets a
       JOIN asset_identifiers ai ON ai.asset_id = a.id
      WHERE a.org_id = $1 AND ai.value = $2
      LIMIT 1`,
    [orgId, target]
  );
  return rows[0]?.criticality ?? 'MEDIUM';
}

export async function recomputeFindingRisk(findingId) {
  const { rows } = await query('SELECT * FROM findings WHERE id = $1', [findingId]);
  const finding = rows[0];
  if (!finding) throw new Error(`finding not found: ${findingId}`);

  const [vulnerability, assetCriticality, decisionInputs] = await Promise.all([
    findBestCveForFinding(finding),
    findAssetCriticality(finding.org_id, finding.target),
    findDecisionInputs(finding.org_id, finding.target),
  ]);

  const { score, breakdown } = computeRiskScore({
    cvssScore: vulnerability?.cvss_score != null ? Number(vulnerability.cvss_score) : null,
    epssScore: vulnerability?.epss_score != null ? Number(vulnerability.epss_score) : null,
    kev: vulnerability?.kev ?? false,
    assetCriticality,
    confidenceScore: finding.confidence_score,
    ...decisionInputs,
  });
  const priority = computePriority(score, vulnerability?.kev ?? false);

  await query(
    `UPDATE findings SET risk_score = $1, priority = $2, risk_breakdown = $3, risk_model_version = $4, updated_at = now()
      WHERE id = $5`,
    [score, priority, JSON.stringify(breakdown), RISK_MODEL_VERSION, findingId]
  );
  await query(
    `INSERT INTO risk_history (finding_id, risk_score, priority, breakdown, risk_model_version)
     VALUES ($1, $2, $3, $4, $5)`,
    [findingId, score, priority, JSON.stringify(breakdown), RISK_MODEL_VERSION]
  );

  return { score, priority, breakdown };
}
