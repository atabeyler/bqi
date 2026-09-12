import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { computeReadiness } from '../src/services/pqcReadiness.js';
import { PQC_CLASSIFICATION_VERSION } from '../src/quantum/pqcClassification.js';

beforeEach(resetDatabase);

async function insertFinding(orgId, { assetId = null, algorithmId, quantumVulnerable, target, certNotAfter = "now() + interval '30 days'" }) {
  await query(
    `INSERT INTO crypto_findings (org_id, asset_id, source, target, protocol, cipher_suite, key_type, key_size_bits,
       algorithm_id, quantum_vulnerable, classification_note, classification_version,
       cert_subject, cert_issuer, cert_not_before, cert_not_after, cert_fingerprint)
     VALUES ($1,$2,'TLS',$3,'TLSv1.3','TLS_AES_256_GCM_SHA384','rsa',2048,$4,$5,'test','${PQC_CLASSIFICATION_VERSION}',
       'CN=x','CN=x', now(), ${certNotAfter}, 'aa:bb')`,
    [orgId, assetId, target, algorithmId, quantumVulnerable]
  );
}

describe('computeReadiness', () => {
  it('makes no claim (null score) when there is no crypto inventory yet', async () => {
    const orgId = await createOrg();
    const result = await computeReadiness(orgId);
    expect(result.readinessScore).toBeNull();
    expect(result.totalFindings).toBe(0);
  });

  it('computes a readiness percentage from classified findings and excludes UNKNOWN from the denominator', async () => {
    const orgId = await createOrg();
    await insertFinding(orgId, { algorithmId: 'RSA', quantumVulnerable: true, target: 'a' });
    await insertFinding(orgId, { algorithmId: 'ML-KEM', quantumVulnerable: false, target: 'b' });
    await insertFinding(orgId, { algorithmId: 'SOMETHING-NEW', quantumVulnerable: null, target: 'c' });

    const result = await computeReadiness(orgId);
    expect(result.totalFindings).toBe(3);
    expect(result.quantumVulnerableCount).toBe(1);
    expect(result.quantumSafeCount).toBe(1);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.readinessScore).toBe(50); // 1 safe / 2 classified
  });

  it('prioritizes a soon-expiring, high-criticality vulnerable finding above a low-criticality one', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const critical = (await query(
      `INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,'crit','WEB_APP','CRITICAL',$2) RETURNING id`,
      [orgId, userId]
    )).rows[0].id;
    const low = (await query(
      `INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,'low','WEB_APP','LOW',$2) RETURNING id`,
      [orgId, userId]
    )).rows[0].id;

    await insertFinding(orgId, { assetId: low, algorithmId: 'RSA', quantumVulnerable: true, target: 'low.test', certNotAfter: "now() + interval '365 days'" });
    await insertFinding(orgId, { assetId: critical, algorithmId: 'RSA', quantumVulnerable: true, target: 'crit.test', certNotAfter: "now() + interval '10 days'" });

    const result = await computeReadiness(orgId);
    expect(result.roadmap[0].target).toBe('crit.test');
    expect(result.roadmap[0].priority).toBeGreaterThan(result.roadmap[1].priority);
    expect(result.roadmap[0].harvestNowDecryptLater).not.toBeNull();
    expect(result.roadmap[0].harvestNowDecryptLater.note).toMatch(/not a claim/);
  });

  it('never flags harvest-now-decrypt-later for a quantum-safe algorithm', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const critical = (await query(
      `INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,'crit','WEB_APP','CRITICAL',$2) RETURNING id`,
      [orgId, userId]
    )).rows[0].id;
    await insertFinding(orgId, { assetId: critical, algorithmId: 'ML-KEM', quantumVulnerable: false, target: 'safe.test' });

    const result = await computeReadiness(orgId);
    expect(result.roadmap).toEqual([]);
  });
});
