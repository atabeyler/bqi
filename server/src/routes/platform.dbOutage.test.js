import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Failure-injection coverage for a database outage: query() rejecting
// (connection dropped, Postgres down, etc.) must degrade routes to a clean
// error response, not crash the process.
const queryMock = vi.fn(async () => { throw new Error('connection terminated unexpectedly'); });

vi.mock('../services/database.js', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../services/ai.js', () => ({ getStatus: () => ({ claude: true, gemini: false, openai: false }) }));
vi.mock('../services/quantum.js', () => ({ isIbmHardwareConfigured: () => false }));
vi.mock('../services/quantumProcess.js', () => ({ checkQuantumWorkerHealth: vi.fn(async () => ({ ok: true })) }));
vi.mock('../lib/objectStorage.js', () => ({ isS3Configured: () => false }));
vi.mock('../services/connectors.js', () => ({ getConnectorStatuses: vi.fn(async () => []), listConnectors: () => [] }));

const { default: platformRouter } = await import('./platform.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/platform', platformRouter);
  return app;
}

function adminToken() {
  return jwt.sign({ userCode: 'BOLD', isAdmin: true, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

describe('DB outage resilience', () => {
  it('reports readiness as not-ok (503) with the DB error surfaced, instead of throwing', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://fake/unreachable';
    try {
      const app = buildApp();
      const res = await request(app).get('/api/platform/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.database).toEqual({ configured: true, ok: false, error: 'connection terminated unexpectedly' });
      expect(res.body.ready).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it('degrades /overview to a clean 500 instead of crashing when the DB is unreachable', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://fake/unreachable';
    try {
      const app = buildApp();
      // Express's default error handler for a thrown/rejected async route
      // (via asyncRoute's .catch(next)) -- confirms the failure is caught
      // and turned into a response, not an unhandled rejection.
      const res = await request(app).get('/api/platform/overview').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(500);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it('degrades /risk to a clean 500 instead of crashing when the DB is unreachable', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://fake/unreachable';
    try {
      const app = buildApp();
      const res = await request(app).get('/api/platform/risk').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(500);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});
