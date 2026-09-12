import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeSbomDocument } from '../../intelligence/sbom.js';
import { AI_NATIVE_CAPABILITIES, AI_NATIVE_RULES } from '../../intelligence/aiSecurity.js';

const MAX_ENTITIES = 5_000;
const MAX_RELATIONSHIPS = 10_000;
const MAX_CONTROLS = 2_000;
const SENSITIVE_KEY = /(?:secret|password|passwd|token|credential|private[_-]?key|api[_-]?key|authorization|cookie|session)/i;

const entitySchema = z.object({
  type: z.string().min(1).max(80),
  key: z.string().min(1).max(500),
  label: z.string().min(1).max(500).optional(),
  provider: z.string().max(80).optional(),
  region: z.string().max(120).optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

const relationshipSchema = z.object({
  sourceType: z.string().min(1).max(80),
  sourceKey: z.string().min(1).max(500),
  targetType: z.string().min(1).max(80),
  targetKey: z.string().min(1).max(500),
  type: z.string().min(1).max(80),
  confidence: z.number().int().min(0).max(100).default(100),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

const controlSchema = z.object({
  key: z.string().min(1).max(500),
  type: z.string().min(1).max(80),
  label: z.string().min(1).max(500).optional(),
  status: z.enum(['EFFECTIVE', 'PARTIAL', 'INEFFECTIVE', 'UNKNOWN']),
  effectiveness: z.number().min(0).max(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
  protects: z.array(z.object({
    entityType: z.string().min(1).max(80),
    entityKey: z.string().min(1).max(500),
  })).max(1_000).default([]),
});

export const postureSnapshotSchema = z.object({
  schemaVersion: z.enum(['1.0', '1.1']),
  source: z.string().min(1).max(120),
  collectedAt: z.string().datetime(),
  entities: z.array(entitySchema).max(MAX_ENTITIES).default([]),
  relationships: z.array(relationshipSchema).max(MAX_RELATIONSHIPS).default([]),
  controls: z.array(controlSchema).max(MAX_CONTROLS).default([]),
  sboms: z.array(z.object({
    format: z.enum(['CYCLONEDX', 'SPDX']),
    document: z.record(z.string(), z.unknown()),
  })).max(20).default([]),
}).refine((snapshot) => snapshot.entities.length > 0 || snapshot.sboms.length > 0, 'snapshot must include entities or an SBOM document');

export function redactSnapshotValue(value, key = '') {
  // Preserve non-secret posture booleans such as tokenPassthrough=false;
  // redact only values capable of carrying secret material.
  if (SENSITIVE_KEY.test(key) && (typeof value === 'string' || (value && typeof value === 'object'))) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSnapshotValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSnapshotValue(child, childKey)]));
  }
  return value;
}

function truthy(value) {
  return value === true || value === 'true' || value === 'ENABLED' || value === 'PUBLIC';
}

function falsy(value) {
  return value === false || value === 'false' || value === 'DISABLED' || value === 'NONE';
}

function listIncludes(value, candidates) {
  const values = Array.isArray(value) ? value.map((entry) => String(entry).toLowerCase()) : [];
  return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
}

function finding(entity, capabilityId, ruleId, title, severity, evidence = {}) {
  const location = entity.label || entity.key;
  return {
    capabilityId,
    category: capabilityId,
    ruleId,
    title,
    description: `${title}. Deterministically derived from the supplied ${entity.type} posture snapshot; validate against the target system before remediation.`,
    engineSeverity: severity,
    cveIds: [],
    cweIds: [],
    location,
    target: entity.key,
    evidence: redactSnapshotValue({ entityType: entity.type, entityKey: entity.key, observed: evidence }),
    references: [],
  };
}

const RULES = [
  { types: ['CLOUD_RESOURCE', 'CLOUD_STORAGE'], when: (a) => truthy(a.public) || truthy(a.internetExposed), cap: 'CLOUD_SECURITY', id: 'BCI-CLOUD-PUBLIC', title: 'Cloud resource is publicly exposed', severity: 'HIGH', evidence: (a) => ({ public: a.public, internetExposed: a.internetExposed }) },
  { types: ['CLOUD_RESOURCE', 'CLOUD_STORAGE'], when: (a) => falsy(a.encrypted), cap: 'CLOUD_SECURITY', id: 'BCI-CLOUD-ENCRYPTION', title: 'Cloud resource encryption is disabled', severity: 'HIGH', evidence: (a) => ({ encrypted: a.encrypted }) },
  { types: ['CLOUD_RESOURCE', 'CLOUD_STORAGE', 'CLOUD_ACCOUNT'], when: (a) => falsy(a.logging), cap: 'CLOUD_SECURITY', id: 'BCI-CLOUD-LOGGING', title: 'Cloud security logging is disabled', severity: 'MEDIUM', evidence: (a) => ({ logging: a.logging }) },
  { types: ['IDENTITY', 'USER', 'ROLE', 'SERVICE_ACCOUNT'], when: (a) => truthy(a.excessivePrivilege) || listIncludes(a.permissions, ['*', '*:*']), cap: 'IDENTITY_SECURITY', id: 'BCI-IAM-EXCESSIVE', title: 'Identity has excessive privileges', severity: 'HIGH', evidence: (a) => ({ excessivePrivilege: a.excessivePrivilege, permissions: a.permissions }) },
  { types: ['IDENTITY', 'USER'], when: (a) => falsy(a.mfa) && truthy(a.interactive), cap: 'IDENTITY_SECURITY', id: 'BCI-IAM-MFA', title: 'Interactive identity does not have MFA', severity: 'HIGH', evidence: (a) => ({ mfa: a.mfa, interactive: a.interactive }) },
  { types: ['ROLE', 'IDENTITY', 'SERVICE_ACCOUNT'], when: (a) => truthy(a.externalTrust) || truthy(a.riskyTrust), cap: 'IDENTITY_SECURITY', id: 'BCI-IAM-TRUST', title: 'Risky external identity trust is configured', severity: 'HIGH', evidence: (a) => ({ externalTrust: a.externalTrust, riskyTrust: a.riskyTrust }) },
  { types: ['KUBERNETES_WORKLOAD', 'POD', 'DEPLOYMENT', 'DAEMONSET', 'STATEFULSET'], when: (a) => truthy(a.privileged), cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-PRIVILEGED', title: 'Kubernetes workload runs privileged', severity: 'CRITICAL', evidence: (a) => ({ privileged: a.privileged }) },
  { types: ['KUBERNETES_WORKLOAD', 'POD', 'DEPLOYMENT', 'DAEMONSET', 'STATEFULSET'], when: (a) => truthy(a.hostNetwork) || truthy(a.hostPath), cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-HOST', title: 'Kubernetes workload uses host-level access', severity: 'HIGH', evidence: (a) => ({ hostNetwork: a.hostNetwork, hostPath: a.hostPath }) },
  { types: ['KUBERNETES_WORKLOAD', 'POD', 'DEPLOYMENT', 'DAEMONSET', 'STATEFULSET'], when: (a) => listIncludes(a.capabilities, ['SYS_ADMIN', 'SYS_PTRACE', 'NET_ADMIN']), cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-CAPABILITIES', title: 'Kubernetes workload has risky Linux capabilities', severity: 'HIGH', evidence: (a) => ({ capabilities: a.capabilities }) },
  { types: ['KUBERNETES_SERVICE', 'SERVICE'], when: (a) => truthy(a.internetExposed) || a.serviceType === 'LoadBalancer' || a.serviceType === 'NodePort', cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-EXPOSED-SERVICE', title: 'Kubernetes service is externally exposed', severity: 'MEDIUM', evidence: (a) => ({ internetExposed: a.internetExposed, serviceType: a.serviceType }) },
  { types: ['KUBERNETES_NAMESPACE', 'KUBERNETES_CLUSTER'], when: (a) => falsy(a.networkPolicy), cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-NETPOL', title: 'Kubernetes network isolation is not enforced', severity: 'MEDIUM', evidence: (a) => ({ networkPolicy: a.networkPolicy }) },
  { types: ['KUBERNETES_ROLE', 'CLUSTER_ROLE', 'ROLE_BINDING'], when: (a) => truthy(a.clusterAdmin) || listIncludes(a.verbs, ['*']), cap: 'KUBERNETES_SECURITY', id: 'BCI-K8S-RBAC', title: 'Kubernetes RBAC grants broad administrative access', severity: 'HIGH', evidence: (a) => ({ clusterAdmin: a.clusterAdmin, verbs: a.verbs, resources: a.resources }) },
  { types: ['DOMAIN', 'SUBDOMAIN', 'IP', 'PORT', 'SERVICE', 'WEB_ENDPOINT', 'API_ENDPOINT', 'CLOUD_ENDPOINT'], when: (a) => truthy(a.newlyDiscovered) || truthy(a.unmanaged), cap: 'EASM', id: 'BCI-EASM-UNMANAGED', title: 'Unmanaged external attack-surface asset discovered', severity: 'MEDIUM', evidence: (a) => ({ newlyDiscovered: a.newlyDiscovered, unmanaged: a.unmanaged }) },
  { types: ['BROWSER_ROUTE', 'WEB_ENDPOINT'], when: (a) => truthy(a.sensitiveFormWithoutCsrf) || truthy(a.mixedContent), cap: 'BROWSER_DAST', id: 'BCI-BROWSER-POSTURE', title: 'Browser-observed application security weakness', severity: 'MEDIUM', evidence: (a) => ({ sensitiveFormWithoutCsrf: a.sensitiveFormWithoutCsrf, mixedContent: a.mixedContent }) },
  { types: ['API', 'API_ENDPOINT', 'GRAPHQL_API', 'GRPC_SERVICE'], when: (a) => falsy(a.authenticationRequired), cap: 'ADVANCED_API_SECURITY', id: 'BCI-API-AUTHN', title: 'API endpoint does not require authentication', severity: 'HIGH', evidence: (a) => ({ protocol: a.protocol, authenticationRequired: a.authenticationRequired }) },
  { types: ['API', 'API_ENDPOINT', 'GRAPHQL_API', 'GRPC_SERVICE'], when: (a) => truthy(a.authorizationFailure) || truthy(a.bolaObserved), cap: 'ADVANCED_API_SECURITY', id: 'BCI-API-AUTHZ', title: 'API authorization validation failed', severity: 'CRITICAL', evidence: (a) => ({ authorizationFailure: a.authorizationFailure, bolaObserved: a.bolaObserved, verification: a.verification }) },
  { types: ['PIPELINE', 'CICD_PIPELINE'], when: (a) => truthy(a.dangerousPermissions) || truthy(a.unsafeExecution), cap: 'CICD_SECURITY', id: 'BCI-CICD-UNSAFE', title: 'CI/CD pipeline has unsafe execution or permissions', severity: 'HIGH', evidence: (a) => ({ dangerousPermissions: a.dangerousPermissions, unsafeExecution: a.unsafeExecution }) },
  { types: ['PIPELINE', 'CICD_PIPELINE'], when: (a) => truthy(a.literalSecret) || truthy(a.untrustedSecretExposure), cap: 'CICD_SECURITY', id: 'BCI-CICD-SECRET', title: 'CI/CD pipeline may expose a secret to untrusted execution', severity: 'CRITICAL', evidence: (a) => ({ literalSecret: a.literalSecret, untrustedSecretExposure: a.untrustedSecretExposure }) },
  { types: ['PACKAGE', 'DEPENDENCY', 'ARTIFACT', 'SBOM'], when: (a) => falsy(a.provenanceVerified) || falsy(a.signed), cap: 'SBOM_INTELLIGENCE', id: 'BCI-SUPPLY-PROVENANCE', title: 'Software artifact provenance or signature is not verified', severity: 'MEDIUM', evidence: (a) => ({ format: a.format, provenanceVerified: a.provenanceVerified, signed: a.signed }) },
  { types: ['CONTAINER', 'WORKLOAD'], when: (a) => truthy(a.privileged) || truthy(a.root) || truthy(a.hostMount), cap: 'WORKLOAD_SECURITY', id: 'BCI-WORKLOAD-PRIVILEGE', title: 'Container or workload has dangerous runtime privileges', severity: 'HIGH', evidence: (a) => ({ privileged: a.privileged, root: a.root, hostMount: a.hostMount }) },
  { types: ['DATABASE', 'DATASTORE'], when: (a) => truthy(a.internetExposed) || truthy(a.public), cap: 'DATABASE_SECURITY', id: 'BCI-DATABASE-EXPOSURE', title: 'Database is publicly reachable', severity: 'CRITICAL', evidence: (a) => ({ internetExposed: a.internetExposed, public: a.public }) },
  { types: ['DATABASE', 'DATASTORE'], when: (a) => falsy(a.encrypted) || truthy(a.insecureAuthentication), cap: 'DATABASE_SECURITY', id: 'BCI-DATABASE-POSTURE', title: 'Database encryption or authentication posture is insecure', severity: 'HIGH', evidence: (a) => ({ encrypted: a.encrypted, insecureAuthentication: a.insecureAuthentication }) },
  { types: ['NETWORK', 'FIREWALL', 'ROUTE', 'PORT', 'SERVICE'], when: (a) => truthy(a.allowAll) || truthy(a.unnecessaryConnectivity) || truthy(a.trustBoundaryBypass), cap: 'NETWORK_SECURITY', id: 'BCI-NETWORK-TRUST', title: 'Network configuration permits risky connectivity', severity: 'HIGH', evidence: (a) => ({ allowAll: a.allowAll, unnecessaryConnectivity: a.unnecessaryConnectivity, trustBoundaryBypass: a.trustBoundaryBypass }) },
  { types: ['CERTIFICATE'], when: (a) => truthy(a.expired) || truthy(a.hostnameMismatch) || truthy(a.weakConfiguration) || truthy(a.reused), cap: 'PKI_INTELLIGENCE', id: 'BCI-PKI-POSTURE', title: 'Certificate posture requires remediation', severity: 'HIGH', evidence: (a) => ({ expired: a.expired, expiresAt: a.expiresAt, issuer: a.issuer, hostnameMismatch: a.hostnameMismatch, weakConfiguration: a.weakConfiguration, reused: a.reused }) },
  { types: ['DNS_ZONE', 'DOMAIN'], when: (a) => falsy(a.dnssec) || truthy(a.danglingReference), cap: 'DNS_EMAIL_SECURITY', id: 'BCI-DNS-POSTURE', title: 'DNS delegation or integrity posture is weak', severity: 'MEDIUM', evidence: (a) => ({ dnssec: a.dnssec, danglingReference: a.danglingReference }) },
  { types: ['EMAIL_DOMAIN'], when: (a) => falsy(a.spf) || falsy(a.dkim) || falsy(a.dmarc), cap: 'DNS_EMAIL_SECURITY', id: 'BCI-EMAIL-POSTURE', title: 'Email authentication posture is incomplete', severity: 'MEDIUM', evidence: (a) => ({ spf: a.spf, dkim: a.dkim, dmarc: a.dmarc, mx: a.mx }) },
  { types: ['DATASTORE', 'STORAGE', 'CLOUD_STORAGE'], when: (a) => truthy(a.sensitiveDataExposed), cap: 'SENSITIVE_DATA_EXPOSURE', id: 'BCI-DATA-EXPOSURE', title: 'Sensitive data exposure was observed', severity: 'CRITICAL', evidence: (a) => ({ sensitiveDataExposed: true, classification: a.classification, matchCount: a.matchCount, sample: '[REDACTED]' }) },
  { types: ['THREAT', 'IOC', 'IOA', 'CAMPAIGN'], when: (a) => truthy(a.matched), cap: 'THREAT_FUSION', id: 'BCI-THREAT-MATCH', title: 'Threat intelligence indicator matches a known asset or exposure', severity: 'HIGH', evidence: (a) => ({ standard: a.standard, matched: a.matched, confidence: a.confidence, techniqueIds: a.techniqueIds }) },
];

const ALL_RULES = [...RULES, ...AI_NATIVE_RULES];

export function analyzePostureSnapshot(snapshot) {
  const parsed = postureSnapshotSchema.parse(snapshot);
  const sbomFacts = parsed.sboms.map((sbom) => normalizeSbomDocument(sbom.format, sbom.document));
  const allEntities = [...parsed.entities, ...sbomFacts.flatMap((facts) => facts.entities)];
  const allRelationships = [...parsed.relationships, ...sbomFacts.flatMap((facts) => facts.relationships)];
  if (allEntities.length > MAX_ENTITIES || allRelationships.length > MAX_RELATIONSHIPS) {
    throw new Error('expanded posture snapshot exceeds entity or relationship limit');
  }
  const entities = [...new Map(allEntities.map((entity) => [`${entity.type.toUpperCase()}:${entity.key}`, { ...entity, type: entity.type.toUpperCase(), attributes: redactSnapshotValue(entity.attributes) }])).values()];
  const findings = [];
  for (const entity of entities) {
    for (const rule of ALL_RULES) {
      if (AI_NATIVE_RULES.includes(rule) && ['AI_PREDICTION', 'MODEL_ESTIMATE'].includes(entity.attributes.evidenceKind)) continue;
      if (rule.types.includes(entity.type) && rule.when(entity.attributes)) {
        const derived = finding(entity, rule.cap, rule.id, rule.title, rule.severity, {
          ...rule.evidence(entity.attributes),
          ...(rule.standards ? { standardMappings: rule.standards } : {}),
        });
        derived.references = rule.standards?.map((mapping) => mapping.source) || [];
        findings.push(derived);
      }
    }
  }
  return {
    schemaVersion: parsed.schemaVersion,
    source: parsed.source,
    collectedAt: parsed.collectedAt,
    payloadHash: createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
    entities,
    relationships: allRelationships.map((relationship) => ({
      ...relationship,
      sourceType: relationship.sourceType.toUpperCase(),
      targetType: relationship.targetType.toUpperCase(),
      type: relationship.type.toUpperCase(),
      evidence: redactSnapshotValue(relationship.evidence),
    })),
    controls: parsed.controls.map((control) => ({ ...control, type: control.type.toUpperCase(), evidence: redactSnapshotValue(control.evidence) })),
    findings,
  };
}

const CAPABILITIES_BY_TARGET = Object.freeze({
  CLOUD_ACCOUNT: ['CLOUD_SECURITY', 'IDENTITY_SECURITY', 'EASM', 'WORKLOAD_SECURITY', 'DATABASE_SECURITY', 'NETWORK_SECURITY', 'PKI_INTELLIGENCE', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  KUBERNETES_CLUSTER: ['KUBERNETES_SECURITY', 'IDENTITY_SECURITY', 'WORKLOAD_SECURITY', 'NETWORK_SECURITY', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  REPOSITORY: ['CICD_SECURITY', 'SBOM_INTELLIGENCE', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  CONTAINER: ['SBOM_INTELLIGENCE', 'WORKLOAD_SECURITY', 'NETWORK_SECURITY', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  API: ['EASM', 'BROWSER_DAST', 'ADVANCED_API_SECURITY', 'PKI_INTELLIGENCE', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  URL: ['EASM', 'BROWSER_DAST', 'ADVANCED_API_SECURITY', 'PKI_INTELLIGENCE', 'DNS_EMAIL_SECURITY', 'SENSITIVE_DATA_EXPOSURE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING', ...AI_NATIVE_CAPABILITIES],
  DOMAIN: ['EASM', 'PKI_INTELLIGENCE', 'DNS_EMAIL_SECURITY', 'THREAT_FUSION', 'COMPLIANCE_MAPPING'],
  SUBDOMAIN: ['EASM', 'PKI_INTELLIGENCE', 'DNS_EMAIL_SECURITY', 'THREAT_FUSION', 'COMPLIANCE_MAPPING'],
  IP: ['EASM', 'NETWORK_SECURITY', 'PKI_INTELLIGENCE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING'],
  CIDR: ['EASM', 'NETWORK_SECURITY', 'PKI_INTELLIGENCE', 'THREAT_FUSION', 'COMPLIANCE_MAPPING'],
});

const allCapabilities = [...new Set(Object.values(CAPABILITIES_BY_TARGET).flat())];

export const postureIntelligenceAdapter = {
  id: 'bci-posture-intelligence',
  name: 'BCI Posture Intelligence',
  license: 'Proprietary',
  intrusiveness: 'PASSIVE',
  supportedTargetTypes: Object.keys(CAPABILITIES_BY_TARGET),
  supportedAnalysisTypes: allCapabilities,
  capabilities: allCapabilities,
  capabilitiesByTargetType: CAPABILITIES_BY_TARGET,
  executionOptions: {
    requiresSnapshot: true,
    schemaVersion: '1.1',
    note: 'Analyzes caller-supplied evidence snapshots; it does not collect credentials or perform exploitation.',
  },
  async healthCheck() {
    return { status: 'HEALTHY', version: '1.1.0', detail: 'native deterministic posture and AI/agent/MCP snapshot analyzer ready' };
  },
  async execute({ snapshot }) {
    if (!snapshot) {
      const error = new Error('posture snapshot is required for bci-posture-intelligence');
      error.skipped = true;
      throw error;
    }
    return analyzePostureSnapshot(snapshot);
  },
};
