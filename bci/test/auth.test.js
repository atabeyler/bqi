import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { hashPassword } from '../src/lib/password.js';

const app = createApp();
const PASSWORD = 'correct horse battery staple';

beforeEach(resetDatabase);

describe('POST /api/v1/auth/login', () => {
  it('rejects a non-existent organization slug', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'no-such-org', email: 'a@b.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects a wrong password', async () => {
    const orgId = await createOrg('Acme', 'acme');
    await createUser(orgId, { email: 'a@acme.test', passwordHash: await hashPassword(PASSWORD) });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'acme', email: 'a@acme.test', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects a blocked user even with the correct password', async () => {
    const orgId = await createOrg('Acme', 'acme');
    const userId = await createUser(orgId, { email: 'a@acme.test', passwordHash: await hashPassword(PASSWORD) });
    await query('UPDATE users SET blocked = true WHERE id = $1', [userId]);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'acme', email: 'a@acme.test', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('issues a token for correct credentials and it authorizes /auth/me', async () => {
    const orgId = await createOrg('Acme', 'acme');
    await createUser(orgId, { email: 'a@acme.test', passwordHash: await hashPassword(PASSWORD), roleId: 'analyst' });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'acme', email: 'a@acme.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeDefined();

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('a@acme.test');
    expect(me.body.permissions).toContain('finding:update');
    expect(me.body.permissions).not.toContain('system:manage');
  });

  it('rejects requests with no token and with a garbage token', async () => {
    const noToken = await request(app).get('/api/v1/auth/me');
    expect(noToken.status).toBe(401);

    const badToken = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-real-token');
    expect(badToken.status).toBe(401);
  });

  it('a token stops working the instant the user is blocked', async () => {
    const orgId = await createOrg('Acme', 'acme');
    const userId = await createUser(orgId, { email: 'a@acme.test', passwordHash: await hashPassword(PASSWORD) });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: 'acme', email: 'a@acme.test', password: PASSWORD });
    const token = login.body.token;

    await query('UPDATE users SET blocked = true WHERE id = $1', [userId]);

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(401);
  });
});
