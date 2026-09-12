import { query } from '../db/client.js';

const FRAMEWORK_MAPPING = Object.freeze({
  'BCI-CLOUD-PUBLIC': { CIS: ['CIS-CLOUD-PUBLIC-ACCESS'], NIST: ['PR.AC-5'], ISO27001: ['A.8.20'] },
  'BCI-CLOUD-ENCRYPTION': { CIS: ['CIS-DATA-ENCRYPTION'], NIST: ['PR.DS-1'], ISO27001: ['A.8.24'] },
  'BCI-CLOUD-LOGGING': { CIS: ['CIS-AUDIT-LOGGING'], NIST: ['DE.CM-1'], ISO27001: ['A.8.15'] },
  'BCI-IAM-EXCESSIVE': { CIS: ['CIS-LEAST-PRIVILEGE'], NIST: ['PR.AC-4'], ISO27001: ['A.5.18'] },
  'BCI-IAM-MFA': { CIS: ['CIS-MFA'], NIST: ['PR.AC-7'], ISO27001: ['A.5.17'] },
  'BCI-K8S-PRIVILEGED': { CIS: ['CIS-K8S-5.2'], NIST: ['PR.PT-3'], ISO27001: ['A.8.9'] },
  'BCI-K8S-RBAC': { CIS: ['CIS-K8S-5.1'], NIST: ['PR.AC-4'], ISO27001: ['A.5.18'] },
  'BCI-NETWORK-TRUST': { CIS: ['CIS-NETWORK-SEGMENTATION'], NIST: ['PR.AC-5'], ISO27001: ['A.8.22'] },
  'BCI-DATABASE-POSTURE': { CIS: ['CIS-DATABASE-ENCRYPTION'], NIST: ['PR.DS-1'], ISO27001: ['A.8.24'] },
  'BCI-CICD-SECRET': { CIS: ['CIS-SECRETS-MANAGEMENT'], NIST: ['PR.DS-5'], ISO27001: ['A.8.12'] },
  'BCI-SUPPLY-PROVENANCE': { CIS: ['CIS-SOFTWARE-INTEGRITY'], NIST: ['ID.SC-4'], ISO27001: ['A.8.25'] },
  'BCI-AI-PROMPT-INJECTION': { OWASP_LLM_2026: ['PROMPT_INJECTION'], NIST_AI_AGENT: ['INPUT_AND_CONTEXT_BOUNDARIES'] },
  'BCI-AI-EXCESSIVE-AGENCY': { OWASP_AGENTIC_2026: ['EXCESSIVE_AGENCY'], OWASP_ACS: ['HUMAN_APPROVAL_BOUNDARY'] },
  'BCI-AI-TOOL-PRIVILEGE': { OWASP_AGENTIC_2026: ['TOOL_MISUSE_AND_IDENTITY_PRIVILEGE_ABUSE'], OWASP_ACS: ['LEAST_PRIVILEGE'] },
  'BCI-AI-SENSITIVE-CONTEXT': { OWASP_LLM_2026: ['SENSITIVE_INFORMATION_DISCLOSURE'], OWASP_ACS: ['CONTEXT_MINIMIZATION'] },
  'BCI-AI-UNSAFE-OUTPUT': { OWASP_LLM_2026: ['IMPROPER_OUTPUT_HANDLING'], OWASP_ACS: ['OUTPUT_VALIDATION'] },
  'BCI-AI-RAG-POISONING-EXPOSURE': { OWASP_LLM_2026: ['VECTOR_AND_EMBEDDING_WEAKNESSES'] },
  'BCI-AI-MEMORY-INTEGRITY': { OWASP_AGENTIC_2026: ['MEMORY_AND_CONTEXT_POISONING'] },
  'BCI-AI-MULTI-AGENT-TRUST': { OWASP_AGENTIC_2026: ['INSECURE_INTER_AGENT_COMMUNICATION'] },
  'BCI-MCP-SHADOW-SERVER': { MCP_SPEC: ['SERVER_TRUST_AND_CONSENT'] },
  'BCI-MCP-TOOL-POISONING': { OWASP_AGENTIC_2026: ['AGENTIC_SUPPLY_CHAIN'], MCP_SPEC: ['TOOL_SAFETY'] },
  'BCI-MCP-COMMAND-INJECTION': { MCP_SPEC: ['TOOL_SAFETY'] },
  'BCI-MCP-TOKEN-BOUNDARY': { MCP_SPEC: ['TOKEN_AUDIENCE_AND_NO_PASSTHROUGH'] },
  'BCI-MCP-CONTEXT-OVERSHARING': { MCP_SPEC: ['DATA_PRIVACY_AND_CONSENT'] },
  'BCI-AI-SUPPLY-PROVENANCE': { OWASP_AGENTIC_2026: ['AGENTIC_SUPPLY_CHAIN'], NIST_AI_AGENT: ['SUPPLY_CHAIN_PROVENANCE'] },
  'BCI-WORKLOAD-IDENTITY-INVALID': { SPIFFE: ['SVID_AND_TRUST_DOMAIN_VALIDATION'] },
  'BCI-WORKLOAD-IDENTITY-TRUST': { SPIFFE: ['TRUST_DOMAIN_ISOLATION'], NIST_AI_AGENT: ['AGENT_IDENTITY_AND_AUTHORITY'] },
});

export function mapComplianceEvidence(items) {
  const assessments = [];
  for (const item of items) {
    const mapping = FRAMEWORK_MAPPING[item.ruleId];
    if (!mapping || !item.evidenceId) continue;
    for (const [framework, controls] of Object.entries(mapping)) {
      for (const controlId of controls) {
        assessments.push({
          framework,
          controlId,
          status: 'NON_COMPLIANT',
          findingId: item.findingId,
          evidenceId: item.evidenceId,
          ruleId: item.ruleId,
          rationale: 'A persisted observed finding is mapped to this control; this is not the cyber risk score.',
        });
      }
    }
  }
  return assessments;
}

export async function buildComplianceAssessment(orgId) {
  const { rows } = await query(
    `SELECT DISTINCT f.id AS finding_id, no.rule_id, de.id AS evidence_id
       FROM findings f
       JOIN finding_sources fs ON fs.finding_id = f.id
       JOIN normalized_observations no ON no.id = fs.normalized_observation_id
       LEFT JOIN decision_evidence de
         ON de.org_id = f.org_id AND de.target = f.target AND de.evidence_type = no.category
      WHERE f.org_id = $1 AND f.status NOT IN ('FALSE_POSITIVE', 'VERIFIED_FIXED')`,
    [orgId]
  );
  const assessments = mapComplianceEvidence(rows.map((row) => ({ findingId: row.finding_id, ruleId: row.rule_id, evidenceId: row.evidence_id })));
  const frameworkIds = ['CIS', 'NIST', 'ISO27001', 'OWASP_LLM_2026', 'OWASP_AGENTIC_2026', 'OWASP_ACS', 'MCP_SPEC', 'SPIFFE', 'NIST_AI_AGENT'];
  const frameworks = Object.fromEntries(frameworkIds.map((framework) => {
    const results = assessments.filter((assessment) => assessment.framework === framework);
    return [framework, { assessedControlCount: results.length, nonCompliantCount: results.length, results }];
  }));
  return {
    assessmentModelVersion: 2,
    frameworks,
    complianceScore: null,
    cyberRiskScoreIncluded: false,
    note: assessments.length === 0
      ? 'No evidence-backed control failures are available; compliance is not inferred.'
      : 'Only evidence-backed failures are reported. Unobserved controls are not marked compliant.',
  };
}
