import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

describe('crypto API', () => {
  it('viewer can read inventory/cbom/readiness but not trigger discovery', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const inventory = await request(app).get('/api/v1/crypto/inventory').set('Authorization', `Bearer ${token}`);
    expect(inventory.status).toBe(200);
    expect(inventory.body.findings).toEqual([]);

    const cbom = await request(app).get('/api/v1/crypto/cbom').set('Authorization', `Bearer ${token}`);
    expect(cbom.status).toBe(200);

    const readiness = await request(app).get('/api/v1/crypto/readiness').set('Authorization', `Bearer ${token}`);
    expect(readiness.status).toBe(200);
    expect(readiness.body.readinessScore).toBeNull();

    const discover = await request(app).post('/api/v1/crypto/discover').set('Authorization', `Bearer ${token}`).send({ target: '127.0.0.1' });
    expect(discover.status).toBe(403);
  });

  it('operator triggering discovery with no approved scope still runs it (scope enforcement removed) and reports a real connection failure', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app).post('/api/v1/crypto/discover').set('Authorization', `Bearer ${token}`).send({ target: '127.0.0.1', port: 1 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('discovery_failed');
  });

  it('discovers a JWT signing algorithm with no scope needed (no network connection made)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const token = signAccessToken({ userId, orgId });
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const jwt = `${b64({ alg: 'RS256' })}.${b64({ sub: 'x' })}.sig`;

    const res = await request(app).post('/api/v1/crypto/discover/jwt').set('Authorization', `Bearer ${token}`).send({ token: jwt });
    expect(res.status).toBe(201);
    expect(res.body.finding.algorithm_id).toBe('RSA');
  });

  it('rejects a malformed JWT with 400, not a 500', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const token = signAccessToken({ userId, orgId });

    const res = await request(app).post('/api/v1/crypto/discover/jwt').set('Authorization', `Bearer ${token}`).send({ token: 'garbage' });
    expect(res.status).toBe(400);
  });

  // A real crypto_findings row for org B (via JWT discovery, which needs no
  // network/scope setup) -- without one, org A seeing an empty inventory
  // would prove nothing about isolation, since org B would have no data
  // either way.
  async function seedCryptoFindingFor(orgId, userId) {
    const token = signAccessToken({ userId, orgId });
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const jwt = `${b64({ alg: 'RS256' })}.${b64({ sub: 'x' })}.sig`;
    const res = await request(app).post('/api/v1/crypto/discover/jwt').set('Authorization', `Bearer ${token}`).send({ token: jwt, label: `${orgId}-secret-label` });
    expect(res.status).toBe(201);
    return res.body.finding;
  }

  it("org A cannot read org B's crypto inventory, CBOM, or PQC readiness data", async () => {
    const orgA = await createOrg('A', 'org-a');
    const orgB = await createOrg('B', 'org-b');
    const userB = await createUser(orgB, { email: 'b@x.com', roleId: 'operator' });
    const bFinding = await seedCryptoFindingFor(orgB, userB);

    const userA = await createUser(orgA, { email: 'a@x.com', roleId: 'viewer' });
    const tokenA = signAccessToken({ userId: userA, orgId: orgA });

    const inventory = await request(app).get('/api/v1/crypto/inventory').set('Authorization', `Bearer ${tokenA}`);
    expect(inventory.status).toBe(200);
    expect(inventory.body.findings).toEqual([]);
    expect(JSON.stringify(inventory.body)).not.toContain(bFinding.id);

    const cbom = await request(app).get('/api/v1/crypto/cbom').set('Authorization', `Bearer ${tokenA}`);
    expect(cbom.body.componentCount).toBe(0);
    expect(JSON.stringify(cbom.body)).not.toContain(`${orgB}-secret-label`);

    const readiness = await request(app).get('/api/v1/crypto/readiness').set('Authorization', `Bearer ${tokenA}`);
    expect(readiness.body.totalFindings).toBe(0);

    // And org B, reading its own data back, actually sees the finding --
    // proving the isolation above is real scoping, not just an empty system.
    const tokenB = signAccessToken({ userId: userB, orgId: orgB });
    const ownInventory = await request(app).get('/api/v1/crypto/inventory').set('Authorization', `Bearer ${tokenB}`);
    expect(ownInventory.body.findings.map((f) => f.id)).toEqual([bFinding.id]);
  });
});
