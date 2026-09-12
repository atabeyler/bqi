import { query } from '../db/client.js';
import { PQC_CLASSIFICATION_VERSION } from '../quantum/pqcClassification.js';

const CRITICALITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const EXPIRY_URGENCY_DAYS = 90;

// This is a documented heuristic BCI can actually justify (asset
// criticality + internet exposure + cert lifetime), NOT a precise cost or
// probability model. Migration Priority is a relative ordering aid, not a
// scientific measurement -- treat it the same way the deterministic Risk
// Score treats its own weighting: explainable, never dressed up as more
// certain than it is.
function migrationPriority(finding) {
  if (finding.quantum_vulnerable !== true) return 0;
  const criticalityWeight = CRITICALITY_WEIGHT[finding.asset_criticality] ?? 1;
  const daysUntilExpiry = finding.cert_not_after
    ? (new Date(finding.cert_not_after).getTime() - Date.now()) / 86_400_000
    : null;
  const expiryUrgency = daysUntilExpiry !== null && daysUntilExpiry <= EXPIRY_URGENCY_DAYS ? 2 : 0;
  // Every TLS-discovered endpoint is, by definition, internet/network
  // reachable -- that's how Crypto Discovery found it -- so exposure is
  // always counted here (source === 'TLS').
  const exposureWeight = finding.source === 'TLS' ? 1 : 0;
  return criticalityWeight + expiryUrgency + exposureWeight;
}

// Harvest-Now-Decrypt-Later (spec section 27): long-lived, sensitive data
// protected today by a quantum-vulnerable asymmetric algorithm is a FUTURE
// confidentiality exposure if an adversary is recording the traffic now for
// later decryption -- never a claim that today's encryption is broken.
// BCI has no direct signal for "data retention requirement" from a bare TLS
// probe, so this uses asset criticality (HIGH/CRITICAL) as the documented
// proxy for "likely to protect long-lived sensitive data" -- flagged as a
// proxy, not asserted as measured fact.
function harvestNowDecryptLater(finding) {
  if (finding.quantum_vulnerable !== true) return null;
  const criticality = finding.asset_criticality;
  if (criticality !== 'HIGH' && criticality !== 'CRITICAL') return null;
  return {
    exposure: 'FUTURE_CONFIDENTIALITY_EXPOSURE',
    note:
      'If this traffic is recorded today, it could be decrypted in the future by a sufficiently ' +
      'capable quantum computer. This is not a claim that the data is decryptable today.',
    proxyBasis: `asset criticality = ${criticality} (used as a proxy for long-lived sensitive data; BCI has no direct data-retention signal)`,
  };
}

export async function computeReadiness(orgId) {
  const { rows } = await query(
    `SELECT cf.*, a.criticality AS asset_criticality
       FROM crypto_findings cf
       LEFT JOIN assets a ON a.id = cf.asset_id
      WHERE cf.org_id = $1`,
    [orgId]
  );

  if (rows.length === 0) {
    return {
      classificationVersion: PQC_CLASSIFICATION_VERSION,
      totalFindings: 0,
      readinessScore: null,
      note: 'no crypto inventory yet -- run Crypto Discovery before drawing any conclusion',
      roadmap: [],
    };
  }

  const vulnerable = rows.filter((r) => r.quantum_vulnerable === true);
  const safe = rows.filter((r) => r.quantum_vulnerable === false);
  const unknown = rows.filter((r) => r.quantum_vulnerable === null);
  const classified = vulnerable.length + safe.length;

  const roadmap = vulnerable
    .map((f) => ({
      target: f.target,
      algorithmId: f.algorithm_id,
      assetCriticality: f.asset_criticality ?? null,
      certNotAfter: f.cert_not_after,
      priority: migrationPriority(f),
      harvestNowDecryptLater: harvestNowDecryptLater(f),
    }))
    .sort((a, b) => b.priority - a.priority);

  return {
    classificationVersion: PQC_CLASSIFICATION_VERSION,
    totalFindings: rows.length,
    quantumVulnerableCount: vulnerable.length,
    quantumSafeCount: safe.length,
    unclassifiedCount: unknown.length,
    // Null, never a fabricated number, when nothing has been classified yet
    // -- an org with only UNKNOWN findings has no basis for a readiness claim.
    readinessScore: classified > 0 ? Math.round((safe.length / classified) * 100) : null,
    roadmap,
  };
}
