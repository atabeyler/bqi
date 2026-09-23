import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// item 16 (RBAC -> ABAC): before this, a non-admin could only ever see
// their OWN analyses -- there was no middle ground between "full admin,
// sees everything" and "siloed to your own reports," which made ordinary
// same-unit case collaboration impossible without over-granting admin
// rights. GET /:id (and the two download routes, same ownership-check
// pattern) now also allow a same-unit teammate to view -- not delete -- a
// record, capped at INTERNAL (see history.js's canViewAsUnitMate).

let joinedRow = null;
let plainSelectQueue = [];

vi.mock('../db/client.js', () => ({
  isDbConfigured: () => true,
  getDb: () => ({
    select: () => ({
      from: () => ({
        // getUserUnit() uses select({unit}).from(userProfiles).where(...) --
        // no leftJoin -- queue is consumed in call order: requester's unit
        // lookup first, then the row owner's.
        where: async () => {
          const next = plainSelectQueue.shift();
          return next ? [next] : [];
        },
        // GET /:id's own row fetch joins in `devices` for the label.
        leftJoin: () => ({
          where: async () => (joinedRow ? [{ analysis: joinedRow, devicePlatform: null }] : []),
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
vi.mock('../services/database.js', () => ({ getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));

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
  plainSelectQueue = [];
  joinedRow = {
    id: 2,
    userCode: 'OTHER-USER',
    category: 'ekonomi', // INTERNAL, see history.rbac.test.js's own convention
    title: 'T', content: 'C', aiProvider: 'Claude', deviceId: 'web',
    dataClassification: null,
    createdAt: new Date(), deletedAt: null,
  };
});

describe('GET /api/history/:id — unit-mate ABAC', () => {
  it('lets a same-unit teammate view an INTERNAL record they do not own', async () => {
    plainSelectQueue = [{ unit: 'ALPHA' }, { unit: 'ALPHA' }];
    const app = buildApp();
    const res = await request(app).get('/api/history/2').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(2);
  });

  it('404s when the requester and owner are in different units', async () => {
    plainSelectQueue = [{ unit: 'ALPHA' }, { unit: 'BRAVO' }];
    const app = buildApp();
    const res = await request(app).get('/api/history/2').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
  });

  it('404s when either side has no unit on file', async () => {
    plainSelectQueue = [{ unit: null }, { unit: 'ALPHA' }];
    const app = buildApp();
    const res = await request(app).get('/api/history/2').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
  });

  it('does not extend unit sharing to a CONFIDENTIAL-or-above record, even for the same unit', async () => {
    joinedRow.category = 'savunma'; // CONFIDENTIAL
    plainSelectQueue = [{ unit: 'ALPHA' }, { unit: 'ALPHA' }];
    const app = buildApp();
    const res = await request(app).get('/api/history/2').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
  });

  it('still 404s a cross-unit request even when the record is only PUBLIC/INTERNAL', async () => {
    plainSelectQueue = [{ unit: 'ALPHA' }, { unit: null }];
    const app = buildApp();
    const res = await request(app).get('/api/history/2').set('Authorization', `Bearer ${token({ role: 'analyst' })}`);
    expect(res.status).toBe(404);
  });
});
