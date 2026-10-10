import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
  for (const engineId of ['nuclei', 'http-fuzz', 'availability-probe', 'intrusive-validation']) {
    await query(
      `INSERT INTO engine_health (engine_id, status, last_checked_at) VALUES ($1, 'HEALTHY', now())
       ON CONFLICT (engine_id) DO UPDATE SET status = 'HEALTHY', last_checked_at = now()`,
      [engineId]
    );
  }
});

async function tokenFor(orgId, roleId, email = `${roleId}@test.local`) {
  const userId = await createUser(orgId, { email, roleId });
  return { userId, token: signAccessToken({ userId, orgId }) };
}

async function approveScope(orgId, userId, target) {
  await query(
    `INSERT INTO authorized_scopes (org_id, name, target, allowed_scan_classes, status, created_by, approved_by, approved_at)
     VALUES ($1, 'scope', $2, '{PASSIVE}', 'APPROVED', $3, $3, now())`,
    [orgId, target, userId]
  );
}

describe('POST /api/v1/scans', () => {
  it('viewer cannot create a scan', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'viewer');
    const res = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    expect(res.status).toBe(403);
  });

  it('operator with permission but no authorized scope can still create a scan (scope enforcement removed)', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const res = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    expect(res.status).toBe(201);
  });

  it.each(['SAFE_ACTIVE', 'RESTRICTED'])('normalizes a SPA fragment before creating a %s URL scan', async (requestedClass) => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const res = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`).send({
      target: 'https://step.stm.com.tr/#/account/login', requestedClass,
      selectedCapabilities: ['WEB'], selectedEngineIds: ['nuclei'],
    });
    expect(res.status).toBe(201);
    const stored = await query('SELECT target, target_type FROM scan_jobs WHERE id=$1', [res.body.job.id]);
    expect(stored.rows[0]).toEqual({ target: 'https://step.stm.com.tr/', target_type: 'URL' });
  });

  it('returns and audits the real PASSIVE rejection reason when posture evidence is absent', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const res = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`).send({
      target: 'https://step.stm.com.tr/#/account/login', requestedClass: 'PASSIVE',
      selectedCapabilities: ['EASM'], selectedEngineIds: ['bci-posture-intelligence'],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'scan_rejected', reason: 'posture_snapshot_required' });
    const audit = await query("SELECT metadata FROM audit_events WHERE action='scan.create_rejected' ORDER BY created_at DESC LIMIT 1");
    expect(audit.rows[0].metadata).toMatchObject({ reason: 'posture_snapshot_required', requestedClass: 'PASSIVE' });
  });

  it('operator with an approved scope can create, view, and cancel a scan', async () => {
    const orgId = await createOrg();
    const { userId, token } = await tokenFor(orgId, 'operator');
    await approveScope(orgId, userId, 'example.com');

    const create = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    expect(create.status).toBe(201);
    expect(create.body.job.status).toBe('QUEUED');

    const get = await request(app).get(`/api/v1/scans/${create.body.job.id}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);

    const cancel = await request(app)
      .post(`/api/v1/scans/${create.body.job.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.job.status).toBe('CANCELLED');
  });

  it('keeps archive and confirmed deletion separate and hides deleted terminal scans from every history view', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const created = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ target: 'presentation.example', requestedClass: 'SAFE_ACTIVE' }).expect(201);
    const id = created.body.job.id;

    await request(app).delete(`/api/v1/scans/${id}`).set('Authorization', `Bearer ${token}`).expect(409);
    await request(app).post(`/api/v1/scans/${id}/cancel`).set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).post(`/api/v1/scans/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).delete(`/api/v1/scans/${id}`).set('Authorization', `Bearer ${token}`).expect(200);

    expect((await request(app).get('/api/v1/scans').set('Authorization', `Bearer ${token}`)).body.jobs).toHaveLength(0);
    expect((await request(app).get('/api/v1/scans?archived=true').set('Authorization', `Bearer ${token}`)).body.jobs).toHaveLength(0);
    await request(app).get(`/api/v1/scans/${id}`).set('Authorization', `Bearer ${token}`).expect(404);
    const stored = await query('SELECT target, result, error, deleted_at FROM scan_jobs WHERE id=$1', [id]);
    expect(stored.rows[0]).toMatchObject({ target: '[deleted]', result: null, error: null });
    expect(stored.rows[0].deleted_at).toBeTruthy();
    const audit = await query("SELECT metadata FROM audit_events WHERE action='scan.delete' AND target_id=$1", [id]);
    expect(audit.rows[0].metadata).toEqual({ detailsRetained: false });
  });

  it('accepts and persists an uncapped ADMIN Smart Resilience plan', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'system_admin');
    const requestedPlan = {
      requestCountMode: 'UNLIMITED', totalRequests: null, concurrency: 75,
      targetRps: 250, durationMs: null,
    };
    const res = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        target: 'example.com', requestedClass: 'RESTRICTED', selectedCapabilities: ['DOS'],
        selectedEngineIds: ['availability-probe'], engineOptions: { 'availability-probe': { requestedPlan } },
      });
    expect(res.status).toBe(201);
    expect(res.body.job.engine_options['availability-probe'].requestedPlan).toEqual(requestedPlan);
  });

  it('rejects CUSTOM resilience mode without a request count', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'system_admin');
    const res = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        target: 'example.com', requestedClass: 'RESTRICTED', selectedCapabilities: ['DOS'],
        selectedEngineIds: ['availability-probe'],
        engineOptions: { 'availability-probe': { requestedPlan: { requestCountMode: 'CUSTOM', concurrency: 10, targetRps: 20 } } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('accepts more than 20 explicit Smart Fuzz USER probes without spending the AI budget', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'system_admin');
    const userPlan = Array.from({ length: 25 }, () => ({
      method: 'GET', url: 'https://example.com/search?q=x', parameter: 'q', location: 'query', categoryId: 'BOUNDARY_EMPTY',
    }));
    const res = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`).send({
      target: 'example.com', requestedClass: 'SAFE_ACTIVE', selectedCapabilities: ['FUZZ'], selectedEngineIds: ['http-fuzz'],
      engineOptions: { 'http-fuzz': { userPlan } },
    });
    expect(res.status).toBe(201);
    expect(res.body.job.engine_options['http-fuzz'].userPlan).toHaveLength(25);
    expect(res.body.job.engine_options['http-fuzz'].adaptivePlan).toBeUndefined();
  });

  it('validates Smart Intrusive USER modules against the live registry before enqueueing', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'system_admin');
    const base = { target: 'example.com', requestedClass: 'RESTRICTED', selectedCapabilities: ['INTRUSIVE'], selectedEngineIds: ['intrusive-validation'] };
    const valid = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ ...base, engineOptions: { 'intrusive-validation': { userSelectedModuleIds: ['CORS_VALIDATION'] } } });
    expect(valid.status).toBe(201);
    expect(valid.body.job.engine_options['intrusive-validation'].userSelectedModuleIds).toEqual(['CORS_VALIDATION']);

    const planned = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ ...base, engineOptions: { 'intrusive-validation': { userSelectedModuleIds: ['IDOR_BOLA_VALIDATION'] } } });
    expect(planned.status).toBe(400);
    expect(planned.body.error).toBe('intrusive_module_not_applicable');

    const unknownAi = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ ...base, engineOptions: { 'intrusive-validation': { adaptivePlan: [{ moduleId: 'NOT_REAL' }] } } });
    expect(unknownAi.status).toBe(400);
    expect(unknownAi.body.error).toBe('unknown_intrusive_module');
  });

  it('GET /:id/engine-runs returns real scan_job_engine_runs rows, never a fake progress percentage', async () => {
    const orgId = await createOrg();
    const { userId, token } = await tokenFor(orgId, 'operator');
    await approveScope(orgId, userId, 'example.com');
    const create = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'SAFE_ACTIVE' });

    await query(
      `INSERT INTO scan_job_engine_runs (job_id, engine_id, status, observation_count, finished_at)
       VALUES ($1, 'nuclei', 'COMPLETED', 3, now())`,
      [create.body.job.id]
    );

    const res = await request(app)
      .get(`/api/v1/scans/${create.body.job.id}/engine-runs`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.engineRuns).toHaveLength(1);
    expect(res.body.engineRuns[0]).toMatchObject({ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 3 });
  });

  it('groups findings by immutable scan evidence and reports the exact finding count', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const first = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ target: 'same.example', requestedClass: 'SAFE_ACTIVE' });
    const second = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ target: 'same.example', requestedClass: 'SAFE_ACTIVE' });

    await insertNormalizedObservation(orgId, first.body.job.id, {
      engineId: 'nuclei', target: 'same.example', ruleId: 'first-only', title: 'First scan finding',
    });
    await correlateJobObservations(orgId, first.body.job.id);

    const firstFindings = await request(app).get(`/api/v1/scans/${first.body.job.id}/findings`)
      .set('Authorization', `Bearer ${token}`);
    const secondFindings = await request(app).get(`/api/v1/scans/${second.body.job.id}/findings`)
      .set('Authorization', `Bearer ${token}`);
    const list = await request(app).get('/api/v1/scans').set('Authorization', `Bearer ${token}`);

    expect(firstFindings.status).toBe(200);
    expect(firstFindings.body.findings.map((finding) => finding.title)).toEqual(['First scan finding']);
    expect(secondFindings.status).toBe(200);
    expect(secondFindings.body.findings).toEqual([]);
    expect(list.body.jobs.find((job) => job.id === first.body.job.id).finding_count).toBe(1);
    expect(list.body.jobs.find((job) => job.id === second.body.job.id).finding_count).toBe(0);
  });

  it('returns only persisted real Smart Resilience rounds for the scan', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'operator');
    const create = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'RESTRICTED', selectedCapabilities: ['DOS'], selectedEngineIds: ['availability-probe'] });
    const round = { type: 'RESILIENCE_ROUND', module: 'BASELINE_PERFORMANCE', source: 'BASE', status: 'STABLE', metrics: { attempted: 100 } };
    await query(
      `INSERT INTO raw_observations (org_id, job_id, engine_id, target, payload) VALUES ($1,$2,'availability-probe','example.com',$3)`,
      [orgId, create.body.job.id, JSON.stringify({ raw: [round] })]
    );
    const res = await request(app).get(`/api/v1/scans/${create.body.job.id}/resilience-rounds`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rounds).toEqual([round]);
  });

  it('returns only persisted real Smart Intrusive records for the scan', async () => {
    const orgId = await createOrg();
    const { token } = await tokenFor(orgId, 'system_admin');
    const create = await request(app).post('/api/v1/scans').set('Authorization', `Bearer ${token}`)
      .send({ target: 'example.com', requestedClass: 'RESTRICTED', selectedCapabilities: ['INTRUSIVE'], selectedEngineIds: ['intrusive-validation'] });
    const record = { type: 'INTRUSIVE_VALIDATION_RECORD', module: 'CORS_VALIDATION', source: 'BASE', verificationStatus: 'VERIFIED', anomalous: false };
    await query(
      `INSERT INTO raw_observations (org_id, job_id, engine_id, target, payload) VALUES ($1,$2,'intrusive-validation','example.com',$3)`,
      [orgId, create.body.job.id, JSON.stringify({ raw: [record], moduleMeta: { attempted: 1 } })]
    );
    const res = await request(app).get(`/api/v1/scans/${create.body.job.id}/intrusive-results`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.executions[0]).toEqual({ records: [record], moduleMeta: { attempted: 1 } });
  });

  it("org A cannot view or cancel org B's scan job", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const b = await tokenFor(orgB, 'operator', 'op@b.test');
    await approveScope(orgB, b.userId, 'b-internal.example');
    const created = await request(app)
      .post('/api/v1/scans')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ target: 'b-internal.example', requestedClass: 'SAFE_ACTIVE' });

    const a = await tokenFor(orgA, 'operator', 'op@a.test');
    const get = await request(app).get(`/api/v1/scans/${created.body.job.id}`).set('Authorization', `Bearer ${a.token}`);
    expect(get.status).toBe(404);

    const cancel = await request(app)
      .post(`/api/v1/scans/${created.body.job.id}/cancel`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(cancel.status).toBe(404);
  });
});
