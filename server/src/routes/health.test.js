import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthRoutes from './health.js';
import { setDbReady } from '../services/dbReadiness.js';

function buildApp() {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
}

describe('GET /api/health/live', () => {
  beforeEach(() => setDbReady(false));

  it('is 200 whether or not the DB is ready (process alive is enough)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');

    setDbReady(true);
    const res2 = await request(app).get('/api/health/live');
    expect(res2.status).toBe(200);
  });
});

describe('GET /api/health/ready', () => {
  beforeEach(() => setDbReady(false));

  it('is 503 while the DB has not finished initializing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('NOT_READY');
  });

  it('is 200 once the DB is initialized', async () => {
    setDbReady(true);
    const app = buildApp();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('never leaks DB credential/host/topology info in the response body', async () => {
    setDbReady(false);
    const app = buildApp();
    const res = await request(app).get('/api/health/ready');
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toMatch(/password|host|port|database_url|connection/);
  });
});
