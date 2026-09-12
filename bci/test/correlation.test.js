import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, insertNormalizedObservation } from './helpers/db.js';
import { buildCorrelationKey, correlateJobObservations } from '../src/services/correlation.js';

beforeEach(resetDatabase);

describe('buildCorrelationKey (pure)', () => {
  it('keys on shared CVEs first, regardless of engine wording', () => {
    const a = { cve_ids: ['CVE-2019-10744'], target: 'example.com', rule_id: 'trivy-rule', location: 'x' };
    const b = { cve_ids: ['CVE-2019-10744'], target: 'example.com', rule_id: 'osv-rule', location: 'y' };
    expect(buildCorrelationKey(a)).toBe(buildCorrelationKey(b));
  });

  it('falls back to rule+location when there is no CVE', () => {
    const a = { cve_ids: [], rule_id: 'eval-detected', location: 'app.js:7', target: 'repo' };
    const b = { cve_ids: [], rule_id: 'eval-detected', location: 'app.js:99', target: 'repo' };
    expect(buildCorrelationKey(a)).not.toBe(buildCorrelationKey(b));
  });
});

describe('correlateJobObservations (integration)', () => {
  it('two engines reporting the same CVE collapse into one Finding with two sources', async () => {
    const orgId = await createOrg();
    const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, 'x@x.com', 'x'])).rows[0].id;
    const realJobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;

    await insertNormalizedObservation(orgId, realJobId, { engineId: 'trivy', cveIds: ['CVE-2019-10744'], target: 't1' });
    await insertNormalizedObservation(orgId, realJobId, { engineId: 'osv-scanner', cveIds: ['CVE-2019-10744'], target: 't1' });

    const findingIds = await correlateJobObservations(orgId, realJobId);
    expect(findingIds).toHaveLength(1);

    const { rows: findings } = await query('SELECT * FROM findings WHERE id = $1', [findingIds[0]]);
    expect(findings[0].verification_status).toBe('CONFIRMED');
    expect(findings[0].confidence_score).toBeGreaterThan(60);

    const { rows: sources } = await query('SELECT * FROM finding_sources WHERE finding_id = $1', [findingIds[0]]);
    expect(sources).toHaveLength(2);
  });

  it('is idempotent: running it twice never creates a duplicate Finding', async () => {
    const orgId = await createOrg();
    const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, 'x@x.com', 'x'])).rows[0].id;
    const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });

    const first = await correlateJobObservations(orgId, jobId);
    const second = await correlateJobObservations(orgId, jobId);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // nothing new to correlate

    const { rows } = await query('SELECT count(*)::int AS n FROM findings WHERE org_id = $1', [orgId]);
    expect(rows[0].n).toBe(1);
  });

  it('merges the same CVE/CWE-less finding from a later job without turning empty arrays into NULL', async () => {
    const orgId = await createOrg();
    const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, 'repeat@x.com', 'x'])).rows[0].id;
    const firstJob = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'example.com','SAFE_ACTIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    const secondJob = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'example.com','SAFE_ACTIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    const observation = { engineId: 'nuclei', category: 'WEB', ruleId: 'missing-header', location: 'https://example.com', target: 'example.com', cveIds: [], cweIds: [] };
    await insertNormalizedObservation(orgId, firstJob, observation);
    await insertNormalizedObservation(orgId, secondJob, observation);

    await expect(correlateJobObservations(orgId, firstJob)).resolves.toHaveLength(1);
    await expect(correlateJobObservations(orgId, secondJob)).resolves.toHaveLength(1);
    const { rows } = await query('SELECT cve_ids, cwe_ids FROM findings WHERE org_id = $1', [orgId]);
    expect(rows).toEqual([{ cve_ids: [], cwe_ids: [] }]);
  });

  it('a lone SECRETS observation produces a Finding needing manual review', async () => {
    const orgId = await createOrg();
    const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, 'x@x.com', 'x'])).rows[0].id;
    const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', category: 'SECRETS', ruleId: 'aws-key', location: '.env', target: 't1' });

    const [findingId] = await correlateJobObservations(orgId, jobId);
    const { rows } = await query('SELECT verification_status, confidence_score FROM findings WHERE id = $1', [findingId]);
    expect(rows[0].verification_status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(rows[0].confidence_score).toBeLessThanOrEqual(50);
  });
});
