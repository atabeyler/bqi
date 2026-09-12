import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { buildCbom } from '../src/services/cbom.js';
import { PQC_CLASSIFICATION_VERSION } from '../src/quantum/pqcClassification.js';

beforeEach(resetDatabase);

async function insertFinding(orgId, { assetId = null, algorithmId = 'RSA', quantumVulnerable = true, target = 'example.test' } = {}) {
  await query(
    `INSERT INTO crypto_findings (org_id, asset_id, source, target, protocol, cipher_suite, key_type, key_size_bits,
       algorithm_id, quantum_vulnerable, classification_note, classification_version,
       cert_subject, cert_issuer, cert_not_before, cert_not_after, cert_fingerprint)
     VALUES ($1,$2,'TLS',$3,'TLSv1.3','TLS_AES_256_GCM_SHA384','rsa',2048,$4,$5,'test','${PQC_CLASSIFICATION_VERSION}',
       'CN=x','CN=x', now(), now() + interval '30 days', 'aa:bb')`,
    [orgId, assetId, target, algorithmId, quantumVulnerable]
  );
}

describe('buildCbom', () => {
  it('produces one component per discovered crypto finding, linked to its asset when known', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const { rows } = await query(
      `INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,'web1','WEB_APP','HIGH',$2) RETURNING id`,
      [orgId, userId]
    );
    await insertFinding(orgId, { assetId: rows[0].id, target: 'web1.test' });
    await insertFinding(orgId, { target: 'unlinked.test', algorithmId: 'ML-KEM', quantumVulnerable: false });

    const cbom = await buildCbom(orgId);
    expect(cbom.componentCount).toBe(2);
    expect(cbom.classificationVersion).toBe(PQC_CLASSIFICATION_VERSION);

    const linked = cbom.components.find((c) => c.target === 'web1.test');
    expect(linked.asset.name).toBe('web1');
    expect(linked.algorithm.quantumVulnerable).toBe(true);

    const unlinked = cbom.components.find((c) => c.target === 'unlinked.test');
    expect(unlinked.asset).toBeNull();
  });

  it('returns an empty CBOM (not an error) for an org with no crypto findings yet', async () => {
    const orgId = await createOrg();
    const cbom = await buildCbom(orgId);
    expect(cbom.componentCount).toBe(0);
    expect(cbom.components).toEqual([]);
  });
});
