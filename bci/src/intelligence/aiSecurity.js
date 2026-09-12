// Deterministic AI/agent/MCP posture rules. These rules consume observed
// target-system facts from the existing posture snapshot adapter. They never
// execute prompts or tools and never treat an AI-generated opinion as evidence.

export const AI_NATIVE_CAPABILITIES = Object.freeze([
  'AI_AGENT_SECURITY',
  'MCP_SECURITY',
  'MITRE_ATLAS',
  'AI_SUPPLY_CHAIN',
  'WORKLOAD_IDENTITY',
]);

const OWASP_LLM_2026 = 'https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/';
const OWASP_AGENTIC_2026 = 'https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/';
const OWASP_ACS = 'https://genai.owasp.org/initiatives/agentic-security-initiative/';
const MCP_SECURITY = 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization';
const SPIFFE = 'https://spiffe.io/docs/latest/spiffe-specs/';

const observed = (value) => value === true || value === 'true' || value === 'OBSERVED' || value === 'ENABLED';
const absent = (value) => value === false || value === 'false' || value === 'ABSENT' || value === 'DISABLED' || value === 'NONE';
const includesAny = (value, candidates) => Array.isArray(value)
  && candidates.some((candidate) => value.map((item) => String(item).toLowerCase()).includes(candidate.toLowerCase()));

function mappings(...items) {
  return items.map(([framework, control, source]) => ({ framework, version: '2026', control, source }));
}

export const AI_NATIVE_RULES = Object.freeze([
  {
    types: ['AI_APPLICATION', 'AI_ENDPOINT', 'MODEL_ENDPOINT'],
    when: (a) => observed(a.untrustedInputReachable) && absent(a.promptBoundaryEnforced),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-PROMPT-INJECTION', title: 'Untrusted input can reach a model without an enforced prompt boundary', severity: 'HIGH',
    evidence: (a) => ({ untrustedInputReachable: a.untrustedInputReachable, promptBoundaryEnforced: a.promptBoundaryEnforced, indirect: a.indirectPromptInjectionReachable }),
    standards: mappings(['OWASP_LLM_TOP_10', 'PROMPT_INJECTION', OWASP_LLM_2026], ['MITRE_ATLAS', 'AML.T0051', 'https://atlas.mitre.org/techniques/AML.T0051']),
  },
  {
    types: ['AI_AGENT'],
    when: (a) => observed(a.autonomousAction) && absent(a.humanApprovalRequired),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-EXCESSIVE-AGENCY', title: 'Autonomous agent actions lack a required human-approval boundary', severity: 'CRITICAL',
    evidence: (a) => ({ autonomousAction: a.autonomousAction, humanApprovalRequired: a.humanApprovalRequired, approvalBoundary: a.approvalBoundary }),
    standards: mappings(['OWASP_AGENTIC_TOP_10', 'EXCESSIVE_AGENCY', OWASP_AGENTIC_2026], ['OWASP_AGENT_CONTROL_STANDARD', 'HUMAN_APPROVAL_BOUNDARY', OWASP_ACS]),
  },
  {
    types: ['AI_AGENT', 'AGENT_TOOL', 'MCP_TOOL'],
    when: (a) => observed(a.excessivePrivilege) || includesAny(a.permissions, ['*', '*:*', 'admin', 'shell', 'write:any']),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-TOOL-PRIVILEGE', title: 'Agent or tool has excessive target-system privileges', severity: 'HIGH',
    evidence: (a) => ({ excessivePrivilege: a.excessivePrivilege, permissions: a.permissions, autonomousAction: a.autonomousAction }),
    standards: mappings(['OWASP_AGENTIC_TOP_10', 'TOOL_MISUSE_AND_IDENTITY_PRIVILEGE_ABUSE', OWASP_AGENTIC_2026], ['OWASP_AGENT_CONTROL_STANDARD', 'LEAST_PRIVILEGE', OWASP_ACS]),
  },
  {
    types: ['AI_APPLICATION', 'AI_AGENT'],
    when: (a) => observed(a.sensitiveContextReachable) && absent(a.contextDlpEnforced),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-SENSITIVE-CONTEXT', title: 'Sensitive context is reachable without an observed DLP boundary', severity: 'CRITICAL',
    evidence: (a) => ({ sensitiveContextReachable: a.sensitiveContextReachable, contextDlpEnforced: a.contextDlpEnforced, dataClassification: a.dataClassification }),
    standards: mappings(['OWASP_LLM_TOP_10', 'SENSITIVE_INFORMATION_DISCLOSURE', OWASP_LLM_2026]),
  },
  {
    types: ['AI_APPLICATION', 'AI_AGENT'],
    when: (a) => observed(a.outputCanExecute) && absent(a.outputValidationEnforced),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-UNSAFE-OUTPUT', title: 'Model output can reach an execution sink without validation', severity: 'CRITICAL',
    evidence: (a) => ({ outputCanExecute: a.outputCanExecute, outputValidationEnforced: a.outputValidationEnforced, executionSink: a.executionSink }),
    standards: mappings(['OWASP_LLM_TOP_10', 'IMPROPER_OUTPUT_HANDLING', OWASP_LLM_2026], ['MITRE_ATLAS', 'AML.T0053', 'https://atlas.mitre.org/techniques/AML.T0053']),
  },
  {
    types: ['VECTOR_STORE', 'RAG_PIPELINE'],
    when: (a) => observed(a.untrustedContentIngestion) && absent(a.retrievalIntegrityValidation),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-RAG-POISONING-EXPOSURE', title: 'RAG ingestion accepts untrusted content without integrity validation', severity: 'HIGH',
    evidence: (a) => ({ untrustedContentIngestion: a.untrustedContentIngestion, retrievalIntegrityValidation: a.retrievalIntegrityValidation, writeSources: a.writeSources }),
    standards: mappings(['OWASP_LLM_TOP_10', 'VECTOR_AND_EMBEDDING_WEAKNESSES', OWASP_LLM_2026], ['MITRE_ATLAS', 'AML.T0070', 'https://atlas.mitre.org/techniques/AML.T0070']),
  },
  {
    types: ['AGENT_MEMORY'],
    when: (a) => observed(a.persistent) && observed(a.untrustedWriteReachable) && absent(a.integrityValidation),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-MEMORY-INTEGRITY', title: 'Persistent agent memory accepts untrusted writes without integrity validation', severity: 'HIGH',
    evidence: (a) => ({ persistent: a.persistent, untrustedWriteReachable: a.untrustedWriteReachable, integrityValidation: a.integrityValidation }),
    standards: mappings(['OWASP_AGENTIC_TOP_10', 'MEMORY_AND_CONTEXT_POISONING', OWASP_AGENTIC_2026]),
  },
  {
    types: ['AI_AGENT', 'MULTI_AGENT_CHANNEL'],
    when: (a) => observed(a.externalAgentTrust) && absent(a.peerIdentityVerified),
    cap: 'AI_AGENT_SECURITY', id: 'BCI-AI-MULTI-AGENT-TRUST', title: 'External agent messages are trusted without peer identity verification', severity: 'HIGH',
    evidence: (a) => ({ externalAgentTrust: a.externalAgentTrust, peerIdentityVerified: a.peerIdentityVerified, trustBoundary: a.trustBoundary }),
    standards: mappings(['OWASP_AGENTIC_TOP_10', 'INSECURE_INTER_AGENT_COMMUNICATION', OWASP_AGENTIC_2026]),
  },
  {
    types: ['MCP_SERVER'],
    when: (a) => observed(a.shadow) || observed(a.unknown) || absent(a.ownerKnown),
    cap: 'MCP_SECURITY', id: 'BCI-MCP-SHADOW-SERVER', title: 'Shadow or ownerless MCP server is present', severity: 'HIGH',
    evidence: (a) => ({ shadow: a.shadow, unknown: a.unknown, ownerKnown: a.ownerKnown, transport: a.transport }),
    standards: mappings(['MCP_SECURITY_GUIDANCE', 'SERVER_TRUST_AND_CONSENT', MCP_SECURITY]),
  },
  {
    types: ['MCP_TOOL'],
    when: (a) => observed(a.definitionChanged) && absent(a.definitionIntegrityVerified),
    cap: 'MCP_SECURITY', id: 'BCI-MCP-TOOL-POISONING', title: 'MCP tool definition changed without verified integrity', severity: 'CRITICAL',
    evidence: (a) => ({ definitionChanged: a.definitionChanged, definitionIntegrityVerified: a.definitionIntegrityVerified, provenance: a.provenance }),
    standards: mappings(['MITRE_ATLAS', 'AML.T0110', 'https://atlas.mitre.org/techniques/AML.T0110'], ['OWASP_AGENTIC_TOP_10', 'AGENTIC_SUPPLY_CHAIN', OWASP_AGENTIC_2026]),
  },
  {
    types: ['MCP_TOOL'],
    when: (a) => observed(a.commandFromContext) && absent(a.argumentValidation),
    cap: 'MCP_SECURITY', id: 'BCI-MCP-COMMAND-INJECTION', title: 'MCP tool builds commands from context without argument validation', severity: 'CRITICAL',
    evidence: (a) => ({ commandFromContext: a.commandFromContext, argumentValidation: a.argumentValidation, capability: a.capability }),
    standards: mappings(['MITRE_ATLAS', 'AML.T0053', 'https://atlas.mitre.org/techniques/AML.T0053'], ['MCP_SECURITY_GUIDANCE', 'TOOL_SAFETY', MCP_SECURITY]),
  },
  {
    types: ['MCP_SERVER', 'MCP_CLIENT'],
    when: (a) => observed(a.tokenPassthrough) || observed(a.tokenInUri) || absent(a.audienceValidation),
    cap: 'MCP_SECURITY', id: 'BCI-MCP-TOKEN-BOUNDARY', title: 'MCP token audience or forwarding boundary is unsafe', severity: 'CRITICAL',
    evidence: (a) => ({ tokenPassthrough: a.tokenPassthrough, tokenInUri: a.tokenInUri, audienceValidation: a.audienceValidation }),
    standards: mappings(['MCP_SECURITY_GUIDANCE', 'TOKEN_AUDIENCE_AND_NO_PASSTHROUGH', MCP_SECURITY], ['MITRE_ATLAS', 'AML.T0055', 'https://atlas.mitre.org/techniques/AML.T0055']),
  },
  {
    types: ['MCP_RESOURCE', 'MCP_SERVER'],
    when: (a) => observed(a.contextOverSharing) || observed(a.sensitiveResourceExposed),
    cap: 'MCP_SECURITY', id: 'BCI-MCP-CONTEXT-OVERSHARING', title: 'MCP resource exposes excessive or sensitive context', severity: 'HIGH',
    evidence: (a) => ({ contextOverSharing: a.contextOverSharing, sensitiveResourceExposed: a.sensitiveResourceExposed, dataClassification: a.dataClassification }),
    standards: mappings(['MCP_SECURITY_GUIDANCE', 'DATA_PRIVACY_AND_CONSENT', MCP_SECURITY]),
  },
  {
    types: ['MODEL', 'DATASET', 'AI_FRAMEWORK', 'MCP_SERVER', 'MCP_TOOL'],
    when: (a) => absent(a.provenanceVerified) || absent(a.signed),
    cap: 'AI_SUPPLY_CHAIN', id: 'BCI-AI-SUPPLY-PROVENANCE', title: 'AI supply-chain component provenance or signature is not verified', severity: 'HIGH',
    evidence: (a) => ({ provenanceVerified: a.provenanceVerified, signed: a.signed, version: a.version, digest: a.digest }),
    standards: mappings(['MITRE_ATLAS', 'AML.T0010', 'https://atlas.mitre.org/techniques/AML.T0010'], ['OWASP_AGENTIC_TOP_10', 'AGENTIC_SUPPLY_CHAIN', OWASP_AGENTIC_2026]),
  },
  {
    types: ['WORKLOAD_IDENTITY', 'SERVICE_IDENTITY', 'AGENT_IDENTITY'],
    when: (a) => observed(a.expired) || observed(a.stale) || observed(a.broken) || observed(a.trustDomainMismatch),
    cap: 'WORKLOAD_IDENTITY', id: 'BCI-WORKLOAD-IDENTITY-INVALID', title: 'Workload identity is stale, broken, expired, or crosses an unexpected trust domain', severity: 'HIGH',
    evidence: (a) => ({ spiffeId: a.spiffeId, trustDomain: a.trustDomain, expired: a.expired, stale: a.stale, broken: a.broken, trustDomainMismatch: a.trustDomainMismatch, expiresAt: a.expiresAt }),
    standards: mappings(['SPIFFE', 'SVID_AND_TRUST_DOMAIN_VALIDATION', SPIFFE]),
  },
  {
    types: ['WORKLOAD_IDENTITY', 'SERVICE_IDENTITY', 'AGENT_IDENTITY'],
    when: (a) => observed(a.excessiveTrust) || observed(a.excessivePrivilege) || includesAny(a.permissions, ['*', '*:*', 'admin']),
    cap: 'WORKLOAD_IDENTITY', id: 'BCI-WORKLOAD-IDENTITY-TRUST', title: 'Workload or agent identity has excessive target-system trust', severity: 'HIGH',
    evidence: (a) => ({ spiffeId: a.spiffeId, excessiveTrust: a.excessiveTrust, excessivePrivilege: a.excessivePrivilege, permissions: a.permissions }),
    standards: mappings(['SPIFFE', 'TRUST_DOMAIN_ISOLATION', SPIFFE], ['NIST_AI_AGENT_SECURITY', 'AGENT_IDENTITY_AND_AUTHORITY', 'https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative']),
  },
]);

export const ATLAS_BY_AI_RULE = Object.freeze(Object.fromEntries(
  AI_NATIVE_RULES.flatMap((rule) => {
    const atlas = rule.standards.find((mapping) => mapping.framework === 'MITRE_ATLAS');
    return atlas ? [[rule.id, { techniqueId: atlas.control, framework: 'ATLAS', catalogVersion: '2026.08', rationale: `Observed facts satisfy ${rule.id}; mapped to ${atlas.control} by the versioned BCI AI rule catalog.` }]] : [];
  })
));

