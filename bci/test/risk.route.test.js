import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

describe('GET /api/v1/risk/*', () => {
  it('requires report:view and returns a clean baseline for an empty org', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const security = await request(app).get('/api/v1/risk/security-score').set('Authorization', `Bearer ${token}`);
    expect(security.status).toBe(200);
    expect(security.body.score).toBe(100);

    const coverage = await request(app).get('/api/v1/risk/coverage-score').set('Authorization', `Bearer ${token}`);
    expect(coverage.status).toBe(200);
    expect(coverage.body.reason).toBe('no_assets');
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/v1/risk/security-score');
    expect(res.status).toBe(401);
  });
});
