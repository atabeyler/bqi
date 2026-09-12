import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const callBci = vi.fn();
const isBciConfigured = vi.fn(() => true);
vi.mock('../services/bciClient.js', () => ({
  callBci: (...args) => callBci(...args),
  isBciConfigured: () => isBciConfigured(),
}));

const { default: cyberAnalysisRouter } = await import('./cyberAnalysis.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function tokenFor(role) {
  return jwt.sign({ userCode: 'u1', nickname: 'Test', role, isAdmin: role === 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cyber-analysis', cyberAnalysisRouter);
  return app;
}

describe('GET /api/cyber-analysis/*', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('rejects a viewer-role user (analyst/admin only)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/overview').set('Authorization', `Bearer ${tokenFor('viewer')}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/overview');
    expect(res.status).toBe(401);
  });

  it('an analyst gets a combined overview when BCI is reachable', async () => {
    callBci.mockResolvedValueOnce({ ok: true, data: { score: 82 } }).mockResolvedValueOnce({ ok: true, data: { score: 60 } });
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/overview').set('Authorization', `Bearer ${tokenFor('analyst')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ securityScore: { score: 82 }, coverageScore: { score: 60 } });
  });

  it('degrades to 503, never crashes, when BCI is unreachable', async () => {
    callBci.mockResolvedValue({ ok: false, reason: 'bci_unreachable' });
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/overview').set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(res.status).toBe(503);
  });

  it('reports availability via /status without requiring a live BCI call', async () => {
    isBciConfigured.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/status').set('Authorization', `Bearer ${tokenFor('analyst')}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(callBci).not.toHaveBeenCalled();
  });
});

describe('/api/cyber-analysis/proxy/* (generic BCI passthrough)', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('forwards a GET to the corresponding BCI path and returns its data', async () => {
    callBci.mockResolvedValueOnce({ ok: true, data: { assets: [{ id: 'a1' }] } });
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/proxy/assets').set('Authorization', `Bearer ${tokenFor('analyst')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assets: [{ id: 'a1' }] });
    expect(callBci).toHaveBeenCalledWith(expect.anything(), '/api/v1/assets', { method: 'GET', body: undefined });
  });

  it('forwards a POST body to the corresponding BCI path', async () => {
    callBci.mockResolvedValueOnce({ ok: true, data: { asset: { id: 'a2' } } });
    const app = buildApp();
    const res = await request(app)
      .post('/api/cyber-analysis/proxy/assets')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ name: 'example.com', assetType: 'DOMAIN' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ asset: { id: 'a2' } });
    expect(callBci).toHaveBeenCalledWith(expect.anything(), '/api/v1/assets', {
      method: 'POST',
      body: { name: 'example.com', assetType: 'DOMAIN' },
    });
  });

  it('allows the bounded Controlled Proof analysis to outlive the short dashboard timeout', async () => {
    callBci.mockResolvedValueOnce({ ok: true, data: { run: { id: 'proof-1', status: 'READY' } } });
    const app = buildApp();
    const res = await request(app)
      .post('/api/cyber-analysis/proxy/controlled-proof/analyze')
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({ targetUrl: 'https://example.com' });
    expect(res.status).toBe(200);
    expect(callBci).toHaveBeenCalledWith(expect.anything(), '/api/v1/controlled-proof/analyze', {
      method: 'POST',
      body: { targetUrl: 'https://example.com' },
      timeoutMs: 5 * 60_000,
    });
  });

  it('forwards a GET query string to the corresponding BCI path (regression: req.params[0] alone drops it)', async () => {
    callBci.mockResolvedValueOnce({ ok: true, data: { engines: [] } });
    const app = buildApp();
    const res = await request(app)
      .get('/api/cyber-analysis/proxy/engines/plan?targetType=DOMAIN&requestedClass=PASSIVE')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`);
    expect(res.status).toBe(200);
    expect(callBci).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/engines/plan?targetType=DOMAIN&requestedClass=PASSIVE',
      { method: 'GET', body: undefined }
    );
  });

  it('relays a real BCI error status/body instead of masking it as 503', async () => {
    callBci.mockResolvedValueOnce({ ok: false, reason: 'bci_error', status: 403, data: { error: 'forbidden' } });
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/proxy/engines').set('Authorization', `Bearer ${tokenFor('analyst')}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('degrades to 503 when BCI is unreachable', async () => {
    callBci.mockResolvedValueOnce({ ok: false, reason: 'bci_unreachable' });
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/proxy/scans').set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'bci_unavailable' });
  });

  it('rejects a viewer-role user the same as every other route in this file', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/cyber-analysis/proxy/assets').set('Authorization', `Bearer ${tokenFor('viewer')}`);
    expect(res.status).toBe(403);
    expect(callBci).not.toHaveBeenCalled();
  });
});

describe('POST /api/cyber-analysis/assistant/scans/:id', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('builds an evidence-bound assessment from the real job and engine runs', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['nuclei'], findingIds: [] } } },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 0 }] },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.evidence.actualExecutedEngines).toEqual(['nuclei']);
    expect(res.body.report.executiveSummary).toMatch(/No verified finding/);
    expect(res.body.report.coverage.actualExecutedEngines).toEqual(['nuclei']);
    expect(callBci).toHaveBeenNthCalledWith(1, expect.anything(), '/api/v1/scans/scan-1');
    expect(callBci).toHaveBeenNthCalledWith(2, expect.anything(), '/api/v1/scans/scan-1/engine-runs');
  });

  it('rejects an unknown data classification before reading BCI data', async () => {
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'OPEN' });
    expect(res.status).toBe(400);
    expect(callBci).not.toHaveBeenCalled();
  });
});

describe('POST /api/cyber-analysis/assistant/scans/:id/fuzz-strategy', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('proposes no plan (deterministic, not an error) when http-fuzz never ran in this scan', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['nuclei'], findingIds: [] } } },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 0 }] },
      })
      .mockResolvedValueOnce({ ok: true, data: { categories: [{ id: 'BOUNDARY_EMPTY' }] } });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/fuzz-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
  });

  it('never calls the AI provider for RESTRICTED evidence (falls back deterministically even with real fuzz findings)', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: {
          job: {
            id: 'scan-1', target: 'example.com', status: 'COMPLETED',
            result: { enginesRun: ['http-fuzz'], findingIds: ['f1'] },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { engineRuns: [{ engine_id: 'http-fuzz', status: 'COMPLETED', observation_count: 12 }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { categories: [{ id: 'BOUNDARY_EMPTY' }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { finding: { id: 'f1', title: 'Reflected payload', category: 'INPUT_ROBUSTNESS', risk_score: 60, priority: 'HIGH', location: 'query:q', evidence: { capability: 'FUZZ', endpoint: 'http://example.com/search', parameter: 'q' } } },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/fuzz-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    // RESTRICTED evidence is never eligible for cloud AI egress -- the
    // classification gate inside generateStructured (dataEgressPolicy)
    // denies every provider, so this always resolves to the deterministic
    // branch here, never a real network call to an AI provider.
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
  });

  it('rejects an unknown data classification before reading BCI data', async () => {
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/fuzz-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'OPEN' });
    expect(res.status).toBe(400);
    expect(callBci).not.toHaveBeenCalled();
  });

  it('degrades to 503 when BCI is unreachable', async () => {
    callBci.mockResolvedValueOnce({ ok: false, reason: 'bci_unreachable' });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/fuzz-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({});
    expect(res.status).toBe(503);
  });
});

describe('POST /api/cyber-analysis/assistant/scans/:id/intrusive-strategy', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('proposes no adaptive plan (deterministic, not an error) with zero prior evidence -- fetches the live module list from BCI itself', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['nuclei'], findingIds: [] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 0 }] } })
      .mockResolvedValueOnce({
        ok: true,
        data: { modules: [{ id: 'CORS_VALIDATION', status: 'IMPLEMENTED' }, { id: 'IDOR_BOLA_VALIDATION', status: 'PLANNED' }] },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/intrusive-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
    expect(callBci).toHaveBeenNthCalledWith(3, expect.anything(), '/api/v1/engines/intrusive-modules');
  });

  it('never calls the AI provider for RESTRICTED evidence even with real prior findings', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['intrusive-validation'], findingIds: ['f1'] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [{ engine_id: 'intrusive-validation', status: 'COMPLETED', observation_count: 3 }] } })
      .mockResolvedValueOnce({ ok: true, data: { modules: [{ id: 'CORS_VALIDATION', status: 'IMPLEMENTED' }] } })
      .mockResolvedValueOnce({
        ok: true,
        data: { finding: { id: 'f1', title: 'CORS reflects untrusted origin', evidence: { capability: 'INTRUSIVE', module: 'CORS_VALIDATION' } } },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/intrusive-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
  });

  it('degrades to 503 when the BCI module registry itself is unreachable', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: [], findingIds: [] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [] } })
      .mockResolvedValueOnce({ ok: false, reason: 'bci_unreachable' });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/intrusive-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({});
    expect(res.status).toBe(503);
  });

  it('rejects an unknown data classification before reading BCI data', async () => {
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/intrusive-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'OPEN' });
    expect(res.status).toBe(400);
    expect(callBci).not.toHaveBeenCalled();
  });
});

describe('POST /api/cyber-analysis/assistant/scans/:id/resilience-strategy', () => {
  beforeEach(() => {
    callBci.mockReset();
    isBciConfigured.mockReset().mockReturnValue(true);
  });

  it('proposes no adaptive plan (deterministic, not an error) with zero prior evidence -- fetches the live module list from BCI itself', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['nuclei'], findingIds: [] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 0 }] } })
      .mockResolvedValueOnce({
        ok: true,
        data: { modules: [{ id: 'CAPACITY', status: 'IMPLEMENTED' }, { id: 'SOAK_ENDURANCE', status: 'PLANNED' }], loadPlanCapabilities: { requestCountOptions: [{ id: 'UNLIMITED', totalRequests: null }], productMaxima: null } },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/resilience-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
    expect(callBci).toHaveBeenNthCalledWith(3, expect.anything(), '/api/v1/engines/resilience-modules');
  });

  it('never calls the AI provider for RESTRICTED evidence even with real prior findings', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: ['availability-probe'], findingIds: ['f1'] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [{ engine_id: 'availability-probe', status: 'COMPLETED', observation_count: 3 }] } })
      .mockResolvedValueOnce({ ok: true, data: { modules: [{ id: 'CAPACITY', status: 'IMPLEMENTED' }] } })
      .mockResolvedValueOnce({
        ok: true,
        data: { finding: { id: 'f1', title: 'Capacity saturated', evidence: { capability: 'DOS', module: 'CAPACITY', status: 'SATURATED' } } },
      });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/resilience-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'RESTRICTED' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('deterministic');
    expect(res.body.adaptivePlan).toEqual([]);
  });

  it('degrades to 503 when the BCI module registry itself is unreachable', async () => {
    callBci
      .mockResolvedValueOnce({
        ok: true,
        data: { job: { id: 'scan-1', target: 'example.com', status: 'COMPLETED', result: { enginesRun: [], findingIds: [] } } },
      })
      .mockResolvedValueOnce({ ok: true, data: { engineRuns: [] } })
      .mockResolvedValueOnce({ ok: false, reason: 'bci_unreachable' });
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/resilience-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({});
    expect(res.status).toBe(503);
  });

  it('rejects an unknown data classification before reading BCI data', async () => {
    const res = await request(buildApp())
      .post('/api/cyber-analysis/assistant/scans/scan-1/resilience-strategy')
      .set('Authorization', `Bearer ${tokenFor('analyst')}`)
      .send({ dataClassification: 'OPEN' });
    expect(res.status).toBe(400);
    expect(callBci).not.toHaveBeenCalled();
  });
});
