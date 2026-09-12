import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';

const app = createApp();

beforeEach(resetDatabase);

describe('graph API RBAC', () => {
  it('viewer cannot trigger a sync but can read reachability', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const sync = await request(app).post('/api/v1/graph/sync').set('Authorization', `Bearer ${token}`);
    expect(sync.status).toBe(403);

    const reachable = await request(app).get('/api/v1/graph/assets/00000000-0000-0000-0000-000000000000/reachable').set('Authorization', `Bearer ${token}`);
    expect(reachable.status).toBe(200);
    expect(reachable.body.reachable).toEqual([]);
  });

  it('operator can trigger a sync', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const token = signAccessToken({ userId, orgId });

    const sync = await request(app).post('/api/v1/graph/sync').set('Authorization', `Bearer ${token}`);
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ assetNodes: 0, vulnerabilityNodes: 0 });
  });

  it('viewer can read attack-paths, patch-order, and defensive-controls (read-only Security Graph Optimizer)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'viewer' });
    const token = signAccessToken({ userId, orgId });

    const attackPaths = await request(app).get('/api/v1/graph/attack-paths').set('Authorization', `Bearer ${token}`);
    expect(attackPaths.status).toBe(200);
    expect(attackPaths.body.attackPaths).toEqual([]);

    const patchOrder = await request(app).get('/api/v1/graph/patch-order').set('Authorization', `Bearer ${token}`);
    expect(patchOrder.status).toBe(200);
    expect(patchOrder.body.patchOrder).toEqual([]);

    const placements = await request(app).get('/api/v1/graph/defensive-controls').set('Authorization', `Bearer ${token}`);
    expect(placements.status).toBe(200);
    expect(placements.body.placements).toEqual([]);
  });
});
