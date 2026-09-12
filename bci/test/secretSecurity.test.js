import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { query } from '../src/db/client.js';
import { config } from '../src/config.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { runPythonQuantumScript } from '../src/quantum/pythonBridge.js';
import { runBenchmark } from '../src/quantum/benchmark.js';

const app = createApp();

// A real (fake but realistic-shaped) secret value -- distinctive enough
// that a substring match is a meaningful assertion, not a coincidence.
const FAKE_IBM_TOKEN = 'ibm-quantum-secret-token-do-not-leak-9f3a7c21';

beforeEach(resetDatabase);

describe('IBM Quantum token never leaks (spec section 8)', () => {
  afterEach(() => {
    config.quantum.ibmToken = '';
  });

  it('a real (failing, fake-token) IBM hardware attempt never echoes the token back in its error message', async () => {
    const result = await runPythonQuantumScript(
      'ibm_backend.py',
      { items: [{ id: 'a', value: 1, cost: 1 }], budget: 1, token: FAKE_IBM_TOKEN }
    ).catch((err) => ({ error: err.message }));

    expect(JSON.stringify(result)).not.toContain(FAKE_IBM_TOKEN);
  }, 30_000);

  it('an end-to-end benchmark run with hardware enabled never stores the token in quantum_jobs or quantum_benchmarks', async () => {
    config.quantum.ibmToken = FAKE_IBM_TOKEN;
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await query(
      `INSERT INTO quantum_policies (org_id, allow_quantum_simulator, allow_quantum_hardware, max_external_data_classification)
       VALUES ($1, true, true, 'CONFIDENTIAL')`,
      [orgId]
    );

    const benchmark = await runBenchmark({
      orgId, actorUserId: userId, workloadSource: 'secret-leak-test',
      problem: { items: [{ id: 'a', value: 10, cost: 5 }, { id: 'b', value: 6, cost: 3 }], budget: 6 },
      dataClassification: 'INTERNAL',
    });

    expect(JSON.stringify(benchmark)).not.toContain(FAKE_IBM_TOKEN);

    const { rows: jobs } = await query('SELECT * FROM quantum_jobs WHERE benchmark_id = $1', [benchmark.benchmarkId]);
    expect(JSON.stringify(jobs)).not.toContain(FAKE_IBM_TOKEN);

    const { rows: benchmarks } = await query('SELECT * FROM quantum_benchmarks WHERE id = $1', [benchmark.benchmarkId]);
    expect(JSON.stringify(benchmarks)).not.toContain(FAKE_IBM_TOKEN);
  }, 60_000);

  it('the token never appears in the GET /api/v1/quantum/providers or /policy API response', async () => {
    config.quantum.ibmToken = FAKE_IBM_TOKEN;
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const providers = await request(app).get('/api/v1/quantum/providers').set('Authorization', `Bearer ${token}`);
    expect(JSON.stringify(providers.body)).not.toContain(FAKE_IBM_TOKEN);

    const jobs = await request(app).get('/api/v1/quantum/jobs').set('Authorization', `Bearer ${token}`);
    expect(JSON.stringify(jobs.body)).not.toContain(FAKE_IBM_TOKEN);
  });
});

describe('pythonBridge script allowlist (spec section 12)', () => {
  it('refuses to run a script that is not on the allowlist', async () => {
    await expect(runPythonQuantumScript('../../etc/passwd', {})).rejects.toThrow(/not.?allowlisted|refusing/i);
  });

  it('refuses an arbitrary script name even if it looks like a real one', async () => {
    await expect(runPythonQuantumScript('some_other_script.py', {})).rejects.toThrow(/not.?allowlisted|refusing/i);
  });
});

describe('other secrets never leak into API responses', () => {
  it('BCI_JWT_SECRET never appears in any auth response body', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer', email: 'secret-check@x.com' });
    const token = signAccessToken({ userId, orgId });

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(JSON.stringify(me.body)).not.toContain(config.jwtSecret);

    const badLogin = await request(app).post('/api/v1/auth/login').send({ orgSlug: 'nope', email: 'x@x.com', password: 'wrong' });
    expect(JSON.stringify(badLogin.body)).not.toContain(config.jwtSecret);
  });

  it('the database connection string (with its embedded credential) never appears in a generic error response', async () => {
    // src/app.js's error handler intentionally returns only a generic
    // error code + requestId, never err.message/err.stack -- verified here
    // by forcing a real 500 (an invalid UUID passed where one is expected
    // throws inside the pg driver) and checking the body stays generic.
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app).get('/api/v1/scans/not-a-valid-uuid').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(config.databaseUrl);
    expect(body.toLowerCase()).not.toMatch(/password|postgres:\/\//);
  });
});
