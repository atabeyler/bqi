import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query } from '../src/db/client.js';
import { resetDatabase } from './helpers/db.js';
import { config } from '../src/config.js';
import { verifyGatewayToken } from '../src/lib/gatewayJwt.js';
import { getOrCreateGatewayOrg, getOrCreateShadowUser } from '../src/services/gatewayProvisioning.js';

const app = createApp();
const GATEWAY_SECRET = 'test-gateway-secret';

function signGatewayToken(payload, secret = GATEWAY_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '5m' });
}

beforeEach(async () => {
  await resetDatabase();
  config.gatewaySecret = GATEWAY_SECRET;
});

afterEach(() => {
  config.gatewaySecret = '';
});

describe('verifyGatewayToken', () => {
  it("rejects a token signed with a different secret (e.g. BCI's own jwtSecret)", () => {
    const forged = signGatewayToken({ sub: 'u1', email: 'u1@x.com' }, config.jwtSecret);
    expect(() => verifyGatewayToken(forged)).toThrow();
  });

  it('rejects a token missing required claims', () => {
    const incomplete = signGatewayToken({ sub: 'u1' }); // no email
    expect(() => verifyGatewayToken(incomplete)).toThrow(/missing required claims/);
  });

  it('accepts a validly signed token with the required claims', () => {
    const token = signGatewayToken({ sub: 'u1', email: 'u1@x.com', role: 'analyst' });
    expect(verifyGatewayToken(token)).toEqual({ externalId: 'u1', email: 'u1@x.com', role: 'analyst' });
  });

  it('fails closed when BCI_GATEWAY_SECRET is not configured', () => {
    config.gatewaySecret = '';
    const token = signGatewayToken({ sub: 'u1', email: 'u1@x.com' });
    expect(() => verifyGatewayToken(token)).toThrow(/not configured/);
  });
});

describe('gateway provisioning', () => {
  it('is idempotent and keeps the role in sync on repeat visits', async () => {
    const orgId = await getOrCreateGatewayOrg('test-gw-org');
    const userId1 = await getOrCreateShadowUser(orgId, { externalId: 'ext-1', email: 'ext-1@x.com', role: 'viewer' });
    const userId2 = await getOrCreateShadowUser(orgId, { externalId: 'ext-1', email: 'ext-1@x.com', role: 'security_admin' });
    expect(userId1).toBe(userId2);

    const { rows } = await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId1]);
    expect(rows.map((r) => r.role_id)).toEqual(['security_admin']);
  });

  it('never escalates an unrecognized role past viewer', async () => {
    const orgId = await getOrCreateGatewayOrg('test-gw-org-2');
    const userId = await getOrCreateShadowUser(orgId, { externalId: 'ext-2', email: 'ext-2@x.com', role: 'super-admin-please' });
    const { rows } = await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId]);
    expect(rows[0].role_id).toBe('viewer');
  });

  it('marks the shadow user with external_source and an unusable password', async () => {
    const orgId = await getOrCreateGatewayOrg('test-gw-org-3');
    const userId = await getOrCreateShadowUser(orgId, { externalId: 'ext-3', email: 'ext-3@x.com', role: 'analyst' });
    const { rows } = await query('SELECT external_source, password_hash FROM users WHERE id = $1', [userId]);
    expect(rows[0].external_source).toBe('gateway:ext-3');
    expect(rows[0].password_hash).not.toBe('');
  });
});

describe('POST /api/v1/gateway/session', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).post('/api/v1/gateway/session');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'x', email: 'x@x.com' }, 'wrong-secret');
    const res = await request(app).post('/api/v1/gateway/session').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('issues a working BCI access token, and the shadow user cannot log in via the normal password flow', async () => {
    const token = signGatewayToken({ sub: 'bqi-user-1', email: 'bqi-user-1@x.com', role: 'analyst' });

    const session = await request(app).post('/api/v1/gateway/session').set('Authorization', `Bearer ${token}`);
    expect(session.status).toBe(200);
    expect(session.body.token).toBeDefined();

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${session.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.roles.map((r) => r.role_id)).toEqual(['analyst']);

    const loginAttempt = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: config.gatewayOrgSlug, email: 'bqi-user-1@x.com', password: 'whatever' });
    expect(loginAttempt.status).toBe(401);
  });

  // Quantum Compute Gateway convergence (spec section 32): the long-term
  // target has BQI and BCI sharing one quantum gateway. Reusing
  // BCI's REST API over the same trusted gateway session this file already
  // tests -- rather than a second, parallel trust mechanism -- is the safe
  // way to get there with zero changes to BQI's own quantum code.
  // No new BCI code was needed for this: a gateway-issued session already
  // carries normal role permissions (rule:view for a viewer/analyst), so it
  // already reaches these endpoints today.
  it('a gateway-issued session (as BQI would hold) can read BCI Quantum Compute Gateway provider health and policy', async () => {
    // Real provider health checks spawn Python subprocesses (qiskit_aer
    // import) -- slower than the default 5s test timeout, not flaky.
    const token = signGatewayToken({ sub: 'bqiuantum-caller', email: 'bqiuantum-caller@x.com', role: 'analyst' });
    const session = await request(app).post('/api/v1/gateway/session').set('Authorization', `Bearer ${token}`);
    expect(session.status).toBe(200);

    const providers = await request(app).get('/api/v1/quantum/providers').set('Authorization', `Bearer ${session.body.token}`);
    expect(providers.status).toBe(200);
    expect(providers.body.providers.map((p) => p.id).sort()).toEqual(['classical', 'ibm_quantum', 'quantum_inspired', 'quantum_simulator']);

    const policy = await request(app).get('/api/v1/quantum/policy').set('Authorization', `Bearer ${session.body.token}`);
    expect(policy.status).toBe(200);
  }, 15_000);

  it('reuses the same BCI org/user across repeat gateway sessions for the same external identity', async () => {
    const token = signGatewayToken({ sub: 'bqi-user-2', email: 'bqi-user-2@x.com', role: 'viewer' });

    const first = await request(app).post('/api/v1/gateway/session').set('Authorization', `Bearer ${token}`);
    const second = await request(app).post('/api/v1/gateway/session').set('Authorization', `Bearer ${token}`);

    const { rows } = await query('SELECT count(*)::int AS n FROM users WHERE email = $1', ['bqi-user-2@x.com']);
    expect(rows[0].n).toBe(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
