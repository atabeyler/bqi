// Canonical BCI cyber-analysis capability registry. Intrusiveness is a
// separate execution-policy dimension and must never be registered here.
const capabilities = new Map();

export function registerCapability(capability) {
  if (!capability?.id || typeof capability.id !== 'string') {
    throw new Error('Capability requires a stable string id');
  }
  const id = capability.id.trim().toUpperCase();
  const normalized = Object.freeze({
    id,
    name: capability.name || id,
    description: capability.description || '',
    category: capability.category || 'GENERAL',
    ...(capability.requiredIntrusiveness ? { requiredIntrusiveness: capability.requiredIntrusiveness } : {}),
  });
  capabilities.set(normalized.id, normalized);
  return normalized;
}

export function getCapability(id) {
  return capabilities.get(String(id || '').toUpperCase()) || null;
}

export function listCapabilities() {
  return [...capabilities.values()];
}

[
  { id: 'SAST', name: 'Static Application Security Testing', description: 'Analyzes source code for security defects.', category: 'CODE', requiredIntrusiveness: 'PASSIVE' },
  { id: 'SCA', name: 'Software Composition Analysis', description: 'Analyzes third-party components and known vulnerabilities.', category: 'SUPPLY_CHAIN', requiredIntrusiveness: 'PASSIVE' },
  { id: 'SECRETS', name: 'Secret Detection', description: 'Detects exposed credentials and secrets.', category: 'CODE', requiredIntrusiveness: 'PASSIVE' },
  { id: 'IAC', name: 'Infrastructure as Code', description: 'Analyzes infrastructure-as-code definitions.', category: 'CONFIGURATION', requiredIntrusiveness: 'PASSIVE' },
  { id: 'CONFIG', name: 'Configuration Analysis', description: 'Detects insecure configuration and misconfiguration.', category: 'CONFIGURATION', requiredIntrusiveness: 'PASSIVE' },
  { id: 'SUPPLY_CHAIN', name: 'Supply Chain Analysis', description: 'Analyzes dependency and software supply-chain exposure.', category: 'SUPPLY_CHAIN', requiredIntrusiveness: 'PASSIVE' },
  { id: 'NETWORK_DISCOVERY', name: 'Network Discovery', description: 'Discovers reachable network services.', category: 'NETWORK', requiredIntrusiveness: 'SAFE_ACTIVE' },
  { id: 'WEB', name: 'Web Security Analysis', description: 'Performs bounded web security checks.', category: 'APPLICATION', requiredIntrusiveness: 'SAFE_ACTIVE' },
  { id: 'API', name: 'API Security Analysis', description: 'Performs bounded API security checks.', category: 'APPLICATION', requiredIntrusiveness: 'SAFE_ACTIVE' },
  { id: 'FUZZ', name: 'HTTP Input Robustness', description: 'Exercises HTTP inputs with bounded malformed and boundary values.', category: 'ACTIVE_VALIDATION', requiredIntrusiveness: 'SAFE_ACTIVE' },
  { id: 'INTRUSIVE', name: 'Advanced Active Validation', description: 'Validates risky behavior without automatic exploitation.', category: 'ACTIVE_VALIDATION', requiredIntrusiveness: 'RESTRICTED' },
  { id: 'DOS', name: 'Availability / Resilience', description: 'Performs bounded availability and resilience observations; it does not generate destructive load.', category: 'RESILIENCE', requiredIntrusiveness: 'RESTRICTED' },
  { id: 'CLOUD_SECURITY', name: 'Cloud Security Posture', description: 'Analyzes evidence-backed AWS, Azure, and GCP resource posture.', category: 'CLOUD', requiredIntrusiveness: 'PASSIVE' },
  { id: 'KUBERNETES_SECURITY', name: 'Kubernetes Security Posture', description: 'Analyzes cluster RBAC, workload, network, and secret exposure posture.', category: 'KUBERNETES', requiredIntrusiveness: 'PASSIVE' },
  { id: 'IDENTITY_SECURITY', name: 'Identity and IAM Security', description: 'Analyzes target-environment identities, privileges, and trust relationships.', category: 'IDENTITY', requiredIntrusiveness: 'PASSIVE' },
  { id: 'EASM', name: 'External Attack Surface Management', description: 'Ingests and correlates externally observed assets without duplicating inventory.', category: 'DISCOVERY', requiredIntrusiveness: 'PASSIVE' },
  { id: 'BROWSER_DAST', name: 'Browser-aware DAST', description: 'Passively analyzes evidence collected by an authorized browser session; active validation remains separately gated.', category: 'APPLICATION', requiredIntrusiveness: 'PASSIVE' },
  { id: 'ADVANCED_API_SECURITY', name: 'Advanced API Security', description: 'Passively analyzes REST, OpenAPI, GraphQL, and gRPC evidence; active validation remains separately gated.', category: 'APPLICATION', requiredIntrusiveness: 'PASSIVE' },
  { id: 'CICD_SECURITY', name: 'CI/CD Security', description: 'Analyzes pipeline permissions, execution, artifacts, and deployment flow.', category: 'SUPPLY_CHAIN', requiredIntrusiveness: 'PASSIVE' },
  { id: 'SBOM_INTELLIGENCE', name: 'SBOM and Provenance Intelligence', description: 'Ingests CycloneDX/SPDX relationships, provenance, and signatures.', category: 'SUPPLY_CHAIN', requiredIntrusiveness: 'PASSIVE' },
  { id: 'WORKLOAD_SECURITY', name: 'Container and Workload Posture', description: 'Analyzes runtime privileges, exposure, identity, and network relationships.', category: 'WORKLOAD', requiredIntrusiveness: 'PASSIVE' },
  { id: 'DATABASE_SECURITY', name: 'Database Security Posture', description: 'Analyzes non-destructive database exposure, encryption, authentication, and access posture.', category: 'DATA', requiredIntrusiveness: 'PASSIVE' },
  { id: 'NETWORK_SECURITY', name: 'Network Security Posture', description: 'Analyzes segmentation, connectivity, routes, and firewall posture.', category: 'NETWORK', requiredIntrusiveness: 'PASSIVE' },
  { id: 'PKI_INTELLIGENCE', name: 'PKI and Certificate Intelligence', description: 'Analyzes certificate lifecycle, ownership, chain, hostname, and reuse evidence.', category: 'CRYPTOGRAPHY', requiredIntrusiveness: 'PASSIVE' },
  { id: 'DNS_EMAIL_SECURITY', name: 'DNS and Email Security Posture', description: 'Analyzes DNS, DNSSEC, SPF, DKIM, DMARC, and MX evidence.', category: 'EXTERNAL', requiredIntrusiveness: 'PASSIVE' },
  { id: 'SENSITIVE_DATA_EXPOSURE', name: 'Sensitive Data Exposure', description: 'Analyzes redacted secret and sensitive-data exposure evidence.', category: 'DATA', requiredIntrusiveness: 'PASSIVE' },
  { id: 'THREAT_FUSION', name: 'Threat Intelligence Fusion', description: 'Correlates STIX/TAXII/IOC/IOA/advisory evidence with real assets.', category: 'INTELLIGENCE', requiredIntrusiveness: 'PASSIVE' },
  { id: 'COMPLIANCE_MAPPING', name: 'Evidence-backed Compliance Mapping', description: 'Maps evidence to CIS, NIST, and ISO 27001 controls without inferring compliance.', category: 'GOVERNANCE', requiredIntrusiveness: 'PASSIVE' },
  { id: 'AI_AGENT_SECURITY', name: 'AI and Agent Security', description: 'Analyzes evidence-backed AI applications, agents, models, tools, RAG, memory, trust, and approval boundaries.', category: 'AI_SECURITY', requiredIntrusiveness: 'PASSIVE' },
  { id: 'MCP_SECURITY', name: 'MCP Security', description: 'Inventories MCP servers, clients, tools, and resources and analyzes observed trust, token, injection, permission, and provenance posture.', category: 'AI_SECURITY', requiredIntrusiveness: 'PASSIVE' },
  { id: 'MITRE_ATLAS', name: 'MITRE ATLAS Intelligence', description: 'Maps exact evidence-backed AI security rules to versioned MITRE ATLAS techniques.', category: 'THREAT', requiredIntrusiveness: 'PASSIVE' },
  { id: 'AI_SUPPLY_CHAIN', name: 'AI/ML-BOM Supply Chain', description: 'Builds model, dataset, framework, dependency, artifact, container, application, and agent provenance chains.', category: 'SUPPLY_CHAIN', requiredIntrusiveness: 'PASSIVE' },
  { id: 'WORKLOAD_IDENTITY', name: 'Agent and Workload Identity', description: 'Analyzes observed SPIFFE/SPIRE SVID, trust-domain, workload, service, and agent identity posture.', category: 'IDENTITY', requiredIntrusiveness: 'PASSIVE' },
].forEach(registerCapability);
