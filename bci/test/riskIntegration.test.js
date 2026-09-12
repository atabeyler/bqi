import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';
import { computeSecurityScore } from '../src/services/securityScore.js';
import { computeCoverageScore } from '../src/services/coverageScore.js';

beforeEach(resetDatabase);

async function seedOrgWithJob(orgName = 'Org', slug = 'org') {
  const orgId = await createOrg(orgName, slug);
  const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, `${slug}@x.com`, 'x'])).rows[0].id;
  const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
  return { orgId, userId, jobId };
}

describe('risk recompute is wired into correlation end-to-end', () => {
  it('a KEV-listed CVE finding gets IMMEDIATE priority automatically', async () => {
    const { orgId, jobId } = await seedOrgWithJob();
    await upsertVulnerability({ cveId: 'CVE-2099-10001', cvssScore: 9.8, kev: true, epssScore: 0.9 });
    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', cveIds: ['CVE-2099-10001'], target: 't1' });

    const [findingId] = await correlateJobObservations(orgId, jobId);
    const { rows } = await query('SELECT risk_score, priority FROM findings WHERE id = $1', [findingId]);
    expect(rows[0].priority).toBe('IMMEDIATE');
    expect(rows[0].risk_score).toBeGreaterThan(50);

    const { rows: history } = await query('SELECT count(*)::int AS n FROM risk_history WHERE finding_id = $1', [findingId]);
    expect(history[0].n).toBe(1);
  });

  it('asset criticality feeds into the same finding\'s risk score', async () => {
    const { orgId, jobId } = await seedOrgWithJob('Org2', 'org2');
    await upsertVulnerability({ cveId: 'CVE-2099-10002', cvssScore: 7.0, kev: false });

    const userId = (await query('SELECT requested_by FROM scan_jobs WHERE id = $1', [jobId])).rows[0].requested_by;
    const { rows: assetRows } = await query(
      `INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,'t1','HOST','CRITICAL',$2) RETURNING id`,
      [orgId, userId]
    );
    await query('INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1, $2, $3)', [assetRows[0].id, 'IP', 't1']);

    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', cveIds: ['CVE-2099-10002'], target: 't1' });
    const [findingId] = await correlateJobObservations(orgId, jobId);

    const { rows } = await query('SELECT risk_breakdown FROM findings WHERE id = $1', [findingId]);
    expect(rows[0].risk_breakdown.assetCriticality).toBe('CRITICAL');
  });
});

describe('computeSecurityScore (integration)', () => {
  it('drops when there is an open high-risk finding, and recovers once it is closed', async () => {
    const { orgId, jobId } = await seedOrgWithJob('Org3', 'org3');
    await upsertVulnerability({ cveId: 'CVE-2099-10003', cvssScore: 9.9, kev: true });
    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', cveIds: ['CVE-2099-10003'], target: 't1' });
    const [findingId] = await correlateJobObservations(orgId, jobId);

    const before = await computeSecurityScore(orgId);
    expect(before.score).toBeLessThan(100);
    expect(before.openFindingCount).toBe(1);

    await query("UPDATE findings SET status = 'FALSE_POSITIVE' WHERE id = $1", [findingId]);
    const after = await computeSecurityScore(orgId);
    expect(after.score).toBe(100);
    expect(after.openFindingCount).toBe(0);
  });
});

describe('computeCoverageScore (integration)', () => {
  it('reports 0 with a reason when the org has no assets', async () => {
    const orgId = await createOrg('Org4', 'org4');
    const result = await computeCoverageScore(orgId);
    expect(result.score).toBe(0);
    expect(result.reason).toBe('no_assets');
  });

  it('rises as more of a REPOSITORY asset\'s expected categories (SAST, SCA, SECRETS) get observed', async () => {
    const { orgId, jobId } = await seedOrgWithJob('Org5', 'org5');
    const userId = (await query('SELECT requested_by FROM scan_jobs WHERE id = $1', [jobId])).rows[0].requested_by;
    const { rows: assetRows } = await query(
      `INSERT INTO assets (org_id, name, asset_type, created_by) VALUES ($1,'repo1','REPOSITORY',$2) RETURNING id`,
      [orgId, userId]
    );
    await query('INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1, $2, $3)', [assetRows[0].id, 'REPO_URL', 't1']);

    const zero = await computeCoverageScore(orgId);
    expect(zero.score).toBe(0);

    await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', category: 'SAST', target: 't1' });
    const oneThird = await computeCoverageScore(orgId);
    expect(oneThird.score).toBe(33);

    await insertNormalizedObservation(orgId, jobId, { engineId: 'osv-scanner', category: 'SCA', target: 't1' });
    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', category: 'SECRETS', target: 't1' });
    const full = await computeCoverageScore(orgId);
    expect(full.score).toBe(100);
  });
});
