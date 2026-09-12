import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('health endpoints', () => {
  it('GET /api/v1/health/live returns ok without touching the database', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('unknown routes return a structured 404', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(res.body.requestId).toBeDefined();
  });

  it('every response carries an x-request-id header', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
