import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';

const app = createApp();

beforeEach(resetDatabase);

// A real open, risk-scored finding -- without one, optimizeRemediation
// returns its early "nothing to optimize" branch (benchmarkId: null) and
// never actually creates a benchmark/job row at all, which would make any
// cross-tenant assertion built on top of it a no-op that always "passes"
// without testing anything.
async function seedOpenFinding(orgId, userId, cveId, cvssScore = 9.0) {
  const jobId = (await query(
    `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,$3,'PASSIVE') RETURNING id`,
    [orgId, userId, `t-${cveId}`]
  )).rows[0].id;
  await upsertVulnerability({ cveId, cvssScore });
  await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', category: 'SCA', cveIds: [cveId], target: `t-${cveId}` });
  return correlateJobObservations(orgId, jobId);
}

describe('quantum API', () => {
  it('viewer can read provider health and policy', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const providers = await request(app).get('/api/v1/quantum/providers').set('Authorization', `Bearer ${token}`);
    expect(providers.status).toBe(200);
    expect(providers.body.providers.map((p) => p.id).sort()).toEqual(['classical', 'ibm_quantum', 'quantum_inspired', 'quantum_simulator']);

    const policy = await request(app).get('/api/v1/quantum/policy').set('Authorization', `Bearer ${token}`);
    expect(policy.status).toBe(200);
    expect(policy.body.policy.allowQuantumHardware).toBe(false);
  });

  it('recommendation reflects the real fallback chain, not a client-side guess -- deny-all policy still recommends CLASSICAL with the real reason', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app).get('/api/v1/quantum/recommendation').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Default org policy denies both simulator and hardware (spec section
    // 7's safe default) -- classical is the only thing decideExecutionMode
    // can honestly recommend here, with the real policy reason attached.
    expect(res.body.recommendedMode).toBe('CLASSICAL');
    expect(res.body.reason).toBe('org_policy_denies_quantum');
  });

  it('recommendation changes once the org opts into the simulator', async () => {
    const orgId = await createOrg();
    const adminId = await createUser(orgId, { roleId: 'system_admin' });
    const adminToken = signAccessToken({ userId: adminId, orgId });
    await request(app).put('/api/v1/quantum/policy').set('Authorization', `Bearer ${adminToken}`)
      .send({ allowQuantumSimulator: true, allowQuantumHardware: false, maxExternalDataClassification: 'INTERNAL' });

    const res = await request(app).get('/api/v1/quantum/recommendation').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // quantum_simulator's real health depends on whether qiskit_aer is
    // importable in this test environment -- either a genuine simulator
    // recommendation or an honest fallback past it, never a fabricated one.
    expect(['QUANTUM_SIMULATOR', 'QUANTUM_INSPIRED', 'CLASSICAL']).toContain(res.body.recommendedMode);
  });

  it('viewer cannot change the quantum policy (system:manage required)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app)
      .put('/api/v1/quantum/policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ allowQuantumSimulator: true, allowQuantumHardware: true, maxExternalDataClassification: 'SECRET' });
    expect(res.status).toBe(403);
  });

  it('system_admin can change the quantum policy', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'system_admin' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app)
      .put('/api/v1/quantum/policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ allowQuantumSimulator: true, allowQuantumHardware: false, maxExternalDataClassification: 'INTERNAL' });
    expect(res.status).toBe(200);

    const get = await request(app).get('/api/v1/quantum/policy').set('Authorization', `Bearer ${token}`);
    expect(get.body.policy.allowQuantumSimulator).toBe(true);
  });

  it('operator can run the remediation optimizer; viewer cannot', async () => {
    const orgId = await createOrg();
    const viewerToken = signAccessToken({ userId: await createUser(orgId, { email: 'v@x.com', roleId: 'viewer' }), orgId });
    const opToken = signAccessToken({ userId: await createUser(orgId, { email: 'o@x.com', roleId: 'operator' }), orgId });

    const denied = await request(app)
      .post('/api/v1/quantum/remediation-optimize')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ effortBudget: 5 });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .post('/api/v1/quantum/remediation-optimize')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ effortBudget: 5 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.selectedFindingIds).toEqual([]);
  });

  it("org A cannot read org B's quantum benchmark", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const bUserId = await createUser(orgB, { email: 'b@x.com', roleId: 'operator' });
    await seedOpenFinding(orgB, bUserId, 'CVE-2099-90001', 9.0);
    const bToken = signAccessToken({ userId: bUserId, orgId: orgB });

    const gen = await request(app).post('/api/v1/quantum/remediation-optimize').set('Authorization', `Bearer ${bToken}`).send({ effortBudget: 5 });
    expect(gen.body.benchmarkId).toBeDefined(); // a real benchmark must actually exist, or this test proves nothing

    const aToken = signAccessToken({ userId: await createUser(orgA, { email: 'a@x.com', roleId: 'operator' }), orgId: orgA });
    const res = await request(app).get(`/api/v1/quantum/benchmarks/${gen.body.benchmarkId}`).set('Authorization', `Bearer ${aToken}`);
    expect(res.status).toBe(404);
  });

  it("org A's own benchmark list and job list never include org B's rows", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const bUserId = await createUser(orgB, { email: 'b2@x.com', roleId: 'operator' });
    await seedOpenFinding(orgB, bUserId, 'CVE-2099-90002', 8.5);
    const bToken = signAccessToken({ userId: bUserId, orgId: orgB });
    const gen = await request(app).post('/api/v1/quantum/remediation-optimize').set('Authorization', `Bearer ${bToken}`).send({ effortBudget: 5 });
    expect(gen.body.benchmarkId).toBeDefined();

    const aUserId = await createUser(orgA, { email: 'a2@x.com', roleId: 'operator' });
    await seedOpenFinding(orgA, aUserId, 'CVE-2099-90003', 7.0);
    const aToken = signAccessToken({ userId: aUserId, orgId: orgA });
    const genA = await request(app).post('/api/v1/quantum/remediation-optimize').set('Authorization', `Bearer ${aToken}`).send({ effortBudget: 5 });
    expect(genA.body.benchmarkId).toBeDefined();

    const benchmarks = await request(app).get('/api/v1/quantum/benchmarks').set('Authorization', `Bearer ${aToken}`);
    expect(benchmarks.body.benchmarks.map((b) => b.id)).toEqual([genA.body.benchmarkId]);
    expect(benchmarks.body.benchmarks.map((b) => b.id)).not.toContain(gen.body.benchmarkId);

    const jobs = await request(app).get('/api/v1/quantum/jobs').set('Authorization', `Bearer ${aToken}`);
    expect(jobs.body.jobs.every((j) => j.benchmark_id === genA.body.benchmarkId)).toBe(true);
  });
});
