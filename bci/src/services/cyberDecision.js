import { createHash } from 'node:crypto';
import { query } from '../db/client.js';
import { solveKnapsackExact } from '../quantum/knapsack.js';

export const DECISION_MODEL_VERSION = 2;
export const DIGITAL_TWIN_VERSION = 2;

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function openFinding(finding) {
  return !['FALSE_POSITIVE', 'VERIFIED_FIXED', 'ACCEPTED_RISK', 'MITIGATED'].includes(finding.status);
}

function affectedByScenario(finding, scenario) {
  if (scenario.type === 'PATCH_CVE') return (finding.cve_ids || finding.cveIds || []).includes(scenario.cveId);
  if (scenario.findingId) return finding.id === scenario.findingId;
  if (scenario.entityKey) return finding.target === scenario.entityKey;
  return false;
}

const REDUCTION_BY_SCENARIO = Object.freeze({
  PATCH_CVE: 1,
  ENABLE_MFA: 0.4,
  REMOVE_PERMISSION: 0.55,
  REMOVE_INTERNET_EXPOSURE: 0.45,
  ADD_SEGMENTATION: 0.35,
  REQUIRE_HUMAN_APPROVAL: 0.6,
  DISABLE_MCP_TOOL: 0.7,
  ROTATE_WORKLOAD_IDENTITY: 0.5,
});

export function simulateDigitalTwin(twin, scenario) {
  const riskBefore = (twin.findings || []).filter(openFinding).reduce((sum, finding) => sum + Number(finding.risk_score ?? finding.riskScore ?? 0), 0);
  const reductionFactor = REDUCTION_BY_SCENARIO[scenario.type];
  if (reductionFactor === undefined) throw new Error(`unsupported scenario type: ${scenario.type}`);

  const findingImpacts = [];
  let estimatedReduction = 0;
  for (const finding of (twin.findings || []).filter(openFinding)) {
    if (!affectedByScenario(finding, scenario)) continue;
    const before = Number(finding.risk_score ?? finding.riskScore ?? 0);
    const after = Math.round(before * (1 - reductionFactor));
    estimatedReduction += before - after;
    findingImpacts.push({ findingId: finding.id, before, after, reduction: before - after });
  }

  const removableEdgeTypes = {
    ENABLE_MFA: new Set(),
    PATCH_CVE: new Set(),
    REMOVE_PERMISSION: new Set(['CAN_ACCESS', 'ASSUMES', 'TRUSTS']),
    REMOVE_INTERNET_EXPOSURE: new Set(['EXPOSES', 'ROUTES_TO', 'PUBLICLY_EXPOSES']),
    ADD_SEGMENTATION: new Set(['CONNECTS_TO', 'ROUTES_TO', 'CAN_ACCESS']),
    REQUIRE_HUMAN_APPROVAL: new Set(['CAN_INVOKE_AUTONOMOUSLY', 'ACTS_WITHOUT_APPROVAL']),
    DISABLE_MCP_TOOL: new Set(['CAN_INVOKE', 'EXPOSES_TOOL', 'USES_TOOL']),
    ROTATE_WORKLOAD_IDENTITY: new Set(['AUTHENTICATES_AS', 'ASSUMES', 'TRUSTS']),
  }[scenario.type];
  const removedEdges = (twin.relationships || []).filter((edge) => {
    const type = edge.relationship_type || edge.type;
    if (!removableEdgeTypes.has(type)) return false;
    const source = edge.source_key || edge.sourceKey;
    const target = edge.target_key || edge.targetKey;
    if (scenario.entityKey) return source === scenario.entityKey || target === scenario.entityKey;
    if (scenario.sourceKey || scenario.targetKey) {
      return (!scenario.sourceKey || source === scenario.sourceKey) && (!scenario.targetKey || target === scenario.targetKey);
    }
    return false;
  });

  return {
    modelVersion: DIGITAL_TWIN_VERSION,
    scenario,
    graphSnapshotHash: twin.graphSnapshotHash || stableHash(twin),
    riskBefore,
    estimatedRiskAfter: Math.max(0, riskBefore - estimatedReduction),
    estimatedRiskReduction: estimatedReduction,
    estimatedRiskReductionPercent: riskBefore > 0 ? Math.round((estimatedReduction / riskBefore) * 100) : 0,
    affectedFindings: findingImpacts,
    closedAttackPathEdges: removedEdges.map((edge) => edge.id || [edge.source_key || edge.sourceKey, edge.relationship_type || edge.type, edge.target_key || edge.targetKey].join(':')),
    assumptions: ['Simulation changes an isolated snapshot only.', 'Risk deltas are deterministic model estimates, not production measurements.'],
  };
}

export async function loadDigitalTwin(orgId) {
  const [{ rows: findings }, { rows: entities }, { rows: relationships }, { rows: controls }] = await Promise.all([
    query(`SELECT id, target, category, title, cve_ids, status, risk_score, risk_breakdown, confidence_score
             FROM findings WHERE org_id = $1`, [orgId]),
    query('SELECT id, entity_type, external_key, label, attributes FROM cyber_entities WHERE org_id = $1', [orgId]),
    query(`SELECT cr.id, source.external_key AS source_key, target.external_key AS target_key,
                  cr.relationship_type, cr.confidence
             FROM cyber_relationships cr
             JOIN cyber_entities source ON source.id = cr.source_entity_id
             JOIN cyber_entities target ON target.id = cr.target_entity_id
            WHERE cr.org_id = $1`, [orgId]),
    query('SELECT id, external_key, control_type, status, effectiveness, evidence FROM security_controls WHERE org_id = $1', [orgId]),
  ]);
  const snapshot = { version: DIGITAL_TWIN_VERSION, findings, entities, relationships, controls };
  return { ...snapshot, graphSnapshotHash: stableHash(snapshot) };
}

export async function runWhatIfSimulation({ orgId, actorUserId, scenario }) {
  const twin = await loadDigitalTwin(orgId);
  const result = simulateDigitalTwin(twin, scenario);
  const { rows } = await query(
    `INSERT INTO simulation_runs (org_id, requested_by, scenario_type, scenario, graph_snapshot_hash, result)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [orgId, actorUserId, scenario.type, JSON.stringify(scenario), twin.graphSnapshotHash, JSON.stringify(result)]
  );
  return { simulationId: rows[0].id, createdAt: rows[0].created_at, ...result };
}

const COST_BY_CATEGORY = Object.freeze({
  SAST: 3, SCA: 2, SECRETS: 2, IAC: 2, CLOUD_SECURITY: 2,
  KUBERNETES_SECURITY: 3, IDENTITY_SECURITY: 2, EASM: 2,
  ADVANCED_API_SECURITY: 3, CICD_SECURITY: 3, SBOM_INTELLIGENCE: 2,
  WORKLOAD_SECURITY: 2, DATABASE_SECURITY: 3, NETWORK_SECURITY: 3,
  PKI_INTELLIGENCE: 1, DNS_EMAIL_SECURITY: 1, SENSITIVE_DATA_EXPOSURE: 3,
  AI_AGENT_SECURITY: 3, MCP_SECURITY: 3, AI_SUPPLY_CHAIN: 3,
  WORKLOAD_IDENTITY: 2, MITRE_ATLAS: 2,
});

function actionForFinding(finding) {
  if (finding.cve_ids?.length) return { type: 'PATCH_CVE', cveId: finding.cve_ids[0], reductionFactor: 1 };
  if (finding.category === 'IDENTITY_SECURITY') return { type: 'REMOVE_PERMISSION', entityKey: finding.target, reductionFactor: 0.55 };
  if (['CLOUD_SECURITY', 'EASM', 'DATABASE_SECURITY'].includes(finding.category)) return { type: 'REMOVE_INTERNET_EXPOSURE', entityKey: finding.target, reductionFactor: 0.45 };
  if (finding.category === 'NETWORK_SECURITY') return { type: 'ADD_SEGMENTATION', entityKey: finding.target, reductionFactor: 0.35 };
  if (finding.category === 'MCP_SECURITY') return { type: 'DISABLE_MCP_TOOL', entityKey: finding.target, reductionFactor: 0.7 };
  if (finding.category === 'WORKLOAD_IDENTITY') return { type: 'ROTATE_WORKLOAD_IDENTITY', entityKey: finding.target, reductionFactor: 0.5 };
  if (finding.category === 'AI_AGENT_SECURITY') return { type: 'REQUIRE_HUMAN_APPROVAL', entityKey: finding.target, reductionFactor: 0.6 };
  return { type: 'REMEDIATE_FINDING', findingId: finding.id, reductionFactor: 0.5 };
}

function actionKey(action) {
  return `${action.type}:${action.cveId || action.entityKey || action.findingId}`;
}

export function rankDecisionActions(findings, effortBudget, dependencies = []) {
  const blockedByFinding = new Map();
  for (const dependency of dependencies) {
    if (!blockedByFinding.has(dependency.findingId)) blockedByFinding.set(dependency.findingId, []);
    blockedByFinding.get(dependency.findingId).push(dependency.dependsOnFindingId);
  }
  const perFinding = findings.filter(openFinding).map((finding) => {
    const riskScore = Number(finding.risk_score ?? finding.riskScore ?? 0);
    const action = actionForFinding(finding);
    const estimatedRiskReduction = Math.max(1, Math.round(riskScore * action.reductionFactor));
    const cost = COST_BY_CATEGORY[finding.category] || 2;
    return {
      id: actionKey(action),
      value: estimatedRiskReduction,
      cost,
      findingId: finding.id,
      title: finding.title,
      target: finding.target,
      riskScore,
      estimatedRiskReduction,
      action: { ...action, findingId: finding.id },
      why: {
        deterministicRiskScore: riskScore,
        confidence: finding.confidence_score ?? finding.confidenceScore ?? null,
        priority: finding.priority ?? null,
        riskBreakdown: finding.risk_breakdown ?? finding.riskBreakdown ?? {},
      },
      blockedByFindingIds: blockedByFinding.get(finding.id) || [],
    };
  });
  const grouped = new Map();
  for (const candidate of perFinding) {
    const existing = grouped.get(candidate.id);
    if (!existing) {
      grouped.set(candidate.id, { ...candidate, findingIds: [candidate.findingId], titles: [candidate.title] });
      continue;
    }
    existing.findingIds.push(candidate.findingId);
    existing.titles.push(candidate.title);
    existing.value += candidate.value;
    existing.estimatedRiskReduction += candidate.estimatedRiskReduction;
    existing.riskScore += candidate.riskScore;
    existing.cost = Math.max(existing.cost, candidate.cost);
    existing.blockedByFindingIds = [...new Set([...existing.blockedByFindingIds, ...candidate.blockedByFindingIds])];
    existing.why = { groupedFindingCount: existing.findingIds.length, findings: [existing.why, candidate.why] };
  }
  const candidates = [...grouped.values()];
  const executableCandidates = candidates.filter((candidate) => candidate.blockedByFindingIds.length === 0);
  const solution = solveKnapsackExact(executableCandidates, effortBudget);
  const selected = new Set(solution.selectedIds);
  const recommendations = candidates
    .filter((candidate) => selected.has(candidate.id))
    .sort((a, b) => b.estimatedRiskReduction / b.cost - a.estimatedRiskReduction / a.cost)
    .map((candidate, index) => ({ rank: index + 1, ...candidate }));
  return {
    recommendations,
    blockedRecommendations: candidates.filter((candidate) => candidate.blockedByFindingIds.length > 0),
    optimizationObjective: solution.objectiveValue,
    candidateCount: candidates.length,
    solver: 'exact-dp-knapsack',
  };
}

export async function runCyberDecision({ orgId, actorUserId, effortBudget = 5 }) {
  const { rows: findings } = await query(
    `SELECT id, target, category, title, cve_ids, status, risk_score, risk_breakdown, confidence_score, priority
       FROM findings WHERE org_id = $1 AND risk_score IS NOT NULL`,
    [orgId]
  );
  const { rows: dependencyRows } = await query(
    `SELECT dependent.finding_id, prerequisite.finding_id AS depends_on_finding_id
       FROM remediation_dependencies rd
       JOIN remediations dependent ON dependent.id = rd.remediation_id
       JOIN remediations prerequisite ON prerequisite.id = rd.depends_on_remediation_id
      WHERE rd.org_id = $1 AND prerequisite.status <> 'DONE'`,
    [orgId]
  );
  const ranked = rankDecisionActions(findings, effortBudget, dependencyRows.map((row) => ({ findingId: row.finding_id, dependsOnFindingId: row.depends_on_finding_id })));
  const totalRiskBefore = findings.filter(openFinding).reduce((sum, finding) => sum + Number(finding.risk_score), 0);
  const estimatedRiskAfter = Math.max(0, totalRiskBefore - ranked.optimizationObjective);
  const decision = {
    modelVersion: DECISION_MODEL_VERSION,
    effortBudget,
    totalRiskBefore,
    estimatedRiskAfter,
    estimatedRiskReduction: totalRiskBefore - estimatedRiskAfter,
    ...ranked,
    limitations: ['Risk reduction is a deterministic model estimate.', 'Operational dependencies outside recorded remediation data are not inferred.'],
  };
  const inputHash = stableHash({ findings, effortBudget });
  const { rows } = await query(
    `INSERT INTO decision_runs (
       org_id, requested_by, model_version, input_hash, recommendations, total_risk_before, estimated_risk_after
     ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [orgId, actorUserId, DECISION_MODEL_VERSION, inputHash, JSON.stringify(decision.recommendations), totalRiskBefore, estimatedRiskAfter]
  );
  return { decisionRunId: rows[0].id, createdAt: rows[0].created_at, inputHash, ...decision };
}

export async function addRemediationDependency({ orgId, remediationId, dependsOnRemediationId, reason }) {
  const { rows: owned } = await query(
    `SELECT id FROM remediations WHERE org_id = $1 AND id = ANY($2)`,
    [orgId, [remediationId, dependsOnRemediationId]]
  );
  if (owned.length !== 2) return null;
  const { rows } = await query(
    `INSERT INTO remediation_dependencies (org_id, remediation_id, depends_on_remediation_id, reason)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, remediation_id, depends_on_remediation_id) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING remediation_id, depends_on_remediation_id, reason`,
    [orgId, remediationId, dependsOnRemediationId, reason]
  );
  return rows[0];
}
