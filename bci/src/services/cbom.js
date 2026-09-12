import { query } from '../db/client.js';
import { PQC_CLASSIFICATION_VERSION } from '../quantum/pqcClassification.js';

// Cryptographic Bill of Materials (spec section 23): one component per
// discovered crypto_findings row -- Asset/Target -> Algorithm -> Key ->
// Certificate -> Protocol. This reads exactly what Crypto Discovery
// actually observed; it never infers or fabricates a component for
// anything that wasn't probed.
export async function buildCbom(orgId) {
  const { rows } = await query(
    `SELECT cf.*, a.name AS asset_name, a.criticality AS asset_criticality
       FROM crypto_findings cf
       LEFT JOIN assets a ON a.id = cf.asset_id
      WHERE cf.org_id = $1
      ORDER BY cf.discovered_at DESC`,
    [orgId]
  );

  const components = rows.map((r) => ({
    target: r.target,
    asset: r.asset_id ? { id: r.asset_id, name: r.asset_name, criticality: r.asset_criticality } : null,
    protocol: r.protocol,
    cipherSuite: r.cipher_suite,
    algorithm: {
      id: r.algorithm_id,
      keyType: r.key_type,
      keySizeBits: r.key_size_bits,
      namedCurve: r.named_curve,
      quantumVulnerable: r.quantum_vulnerable,
      classificationVersion: r.classification_version,
      note: r.classification_note,
    },
    certificate: r.cert_subject
      ? {
          subject: r.cert_subject,
          issuer: r.cert_issuer,
          notBefore: r.cert_not_before,
          notAfter: r.cert_not_after,
          fingerprint256: r.cert_fingerprint,
        }
      : null,
    discoveredAt: r.discovered_at,
  }));

  return {
    orgId,
    generatedAt: new Date().toISOString(),
    classificationVersion: PQC_CLASSIFICATION_VERSION,
    componentCount: components.length,
    components,
  };
}
