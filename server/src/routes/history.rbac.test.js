import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

let fakeRow = null;
const poolQuery = vi.fn(async () => ({ rows: [] }));

vi.mock('../db/client.js', () => ({
  isDbConfigured: () => true,
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => (fakeRow ? [fakeRow] : []),
        // GET /:id joins in `devices` for the device_label field -- plain
        // .where() above (unjoined) still backs /download, /download-pdf,
        // and DELETE's own ownership lookup, which never join.
        leftJoin: () => ({
          where: async () => (fakeRow ? [{ analysis: fakeRow, devicePlatform: fakeRow.devicePlatform ?? null }] : []),
        }),
      }),
    }),
  }),
}));
vi.mock('../db/schema.js', () => ({ analyses: {}, devices: {}, emergencyLogs: {}, userProfiles: {} }));
vi.mock('../services/docx.js', () => ({ generateReportDocx: vi.fn(async () => Buffer.from('docx')) }));
vi.mock('../services/pdf.js', () => ({ generateReportPdf: vi.fn(async () => Buffer.from('pdf')) }));
vi.mock('../services/morningBrief.js', () => ({
  getTodayBriefing: vi.fn(), getBriefingByDate: vi.fn(), listBriefingDates: vi.fn(), generateMorningBriefIfNeeded: vi.fn(),
}));
// Only stubs getPool() (used by the new DELETE route below) -- this
// module's separate query() export (used by authMiddleware's
// blockedUserCache) is left real, which harmlessly logs a connection
// error and falls back to "not blocked" since no DATABASE_URL is set in
// this test environment.
vi.mock('../services/database.js', () => ({ getPool: () => ({ query: poolQuery }) }));

const { default: historyRouter } = await import('./history.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/history', historyRouter);
  return app;
}

function token(claims = {}) {
  return jwt.sign({ userCode: 'BOLD-001', ...claims }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  fakeRow = { id: 1, userCode: 'BOLD-001', category: 'savunma', title: 'T', content: 'C', aiProvider: 'Claude', deviceId: 'web', createdAt: new Date(), deletedAt: null };
  poolQuery.mockClear();
});

describe('GET /api/history/:id — classification access control', () => {
  it('blocks a viewer-role owner from reading their own CONFIDENTIAL-category record', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'viewer' })}`);
    expect(res.status).toBe(403);
  });

  it('allows an analyst-role owner to read their own CONFIDENTIAL-category record', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  it('allows a viewer-role owner to read an INTERNAL-category record', async () => {
    fakeRow.category = 'ekonomi';
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'viewer' })}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/history/:id/download — classification access control', () => {
  it('blocks a viewer-role owner from downloading a CONFIDENTIAL-category record', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/history/1/download').set('Authorization', `Bearer ${token({ role: 'viewer' })}`);
    expect(res.status).toBe(403);
  });

  it('allows an analyst-role owner to download a CONFIDENTIAL-category record', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/history/1/download').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/history/:id/download-pdf — classification access control', () => {
  it('blocks a viewer-role owner from downloading a CONFIDENTIAL-category record', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/history/1/download-pdf').set('Authorization', `Bearer ${token({ role: 'viewer' })}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/history/:id — engine and device labels', () => {
  it('masks a real cloud provider name to the generic public label', async () => {
    fakeRow.aiProvider = 'Claude';
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.body.engine_label).toBe('Q CLOUD');
  });

  it('passes a local-engine label through unmasked', async () => {
    fakeRow.aiProvider = 'Q LOCAL';
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.body.engine_label).toBe('Q LOCAL');
  });

  it('labels a web-originated row (the deviceId sentinel) as Web', async () => {
    fakeRow.deviceId = 'web';
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.body.device_label).toBe('Web');
  });

  it('translates a registered device\'s raw platform string to a display name', async () => {
    fakeRow.deviceId = 'device-123';
    fakeRow.devicePlatform = 'android';
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.body.device_label).toBe('Android');
  });

  it('falls back to an honest "unknown device" label when the device was never registered', async () => {
    fakeRow.deviceId = 'device-unregistered';
    fakeRow.devicePlatform = null;
    const app = buildApp();
    const res = await request(app).get('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.body.device_label).toBe('Bilinmeyen Cihaz');
  });
});

describe('DELETE /api/history/:id', () => {
  it('soft-deletes an owned record and bumps sync_revision so native devices learn about it', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery.mock.calls[0][0]).toMatch(/sync_revision = nextval/);
    expect(poolQuery.mock.calls[0][1]).toEqual([1]);
  });

  it('404s for a record owned by someone else', async () => {
    fakeRow.userCode = 'OTHER-USER';
    const app = buildApp();
    const res = await request(app).delete('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('404s for an already-deleted record', async () => {
    fakeRow.deletedAt = new Date();
    const app = buildApp();
    const res = await request(app).delete('/api/history/1').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
