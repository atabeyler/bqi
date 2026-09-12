import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { syncSecurityGraph, findReachableAssets } from '../src/services/securityGraph.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';

beforeEach(resetDatabase);

async function makeAsset(orgId, userId, name, type, criticality = 'MEDIUM') {
  const { rows } = await query(
    'INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orgId, name, type, criticality, userId]
  );
  return rows[0].id;
}

describe('Security Graph', () => {
  it('is idempotent: syncing twice never duplicates nodes or edges', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const hostId = await makeAsset(orgId, userId, 'host-1', 'HOST');
    const appId = await makeAsset(orgId, userId, 'app-1', 'WEB_APP');
    await query('INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,\'HOSTS\')', [orgId, hostId, appId]);

    await syncSecurityGraph(orgId);
    await syncSecurityGraph(orgId);

    const { rows: nodeCount } = await query('SELECT count(*)::int AS n FROM security_graph_nodes WHERE org_id = $1', [orgId]);
    const { rows: edgeCount } = await query('SELECT count(*)::int AS n FROM security_graph_edges WHERE org_id = $1', [orgId]);
    expect(nodeCount[0].n).toBe(2);
    expect(edgeCount[0].n).toBe(1);
  });

  it('defensive attack-path: a vulnerable edge host reaches a critical app it hosts', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const edgeHostId = await makeAsset(orgId, userId, 'edge-host', 'HOST', 'MEDIUM');
    const criticalAppId = await makeAsset(orgId, userId, 'payments-app', 'WEB_APP', 'CRITICAL');
    const unrelatedId = await makeAsset(orgId, userId, 'unrelated-app', 'WEB_APP', 'HIGH');

    await query('INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,\'HOSTS\')', [orgId, edgeHostId, criticalAppId]);

    await syncSecurityGraph(orgId);
    const reachable = await findReachableAssets(orgId, edgeHostId);

    expect(reachable.map((r) => r.asset_id)).toContain(criticalAppId);
    expect(reachable.map((r) => r.asset_id)).not.toContain(unrelatedId);
    expect(reachable.find((r) => r.asset_id === criticalAppId).criticality).toBe('CRITICAL');
  });

  it('follows multi-hop chains (edge -> host -> app)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const a = await makeAsset(orgId, userId, 'a', 'HOST');
    const b = await makeAsset(orgId, userId, 'b', 'HOST');
    const c = await makeAsset(orgId, userId, 'c', 'WEB_APP', 'CRITICAL');
    await query('INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,\'CONNECTS_TO\')', [orgId, a, b]);
    await query('INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,\'HOSTS\')', [orgId, b, c]);

    await syncSecurityGraph(orgId);
    const reachable = await findReachableAssets(orgId, a);
    expect(reachable.map((r) => r.asset_id).sort()).toEqual([b, c].sort());
  });

  it('links a vulnerable asset to the CVE affecting it via AFFECTED_BY', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const assetId = await makeAsset(orgId, userId, 'server-1', 'HOST', 'HIGH');
    await query('INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1, \'IP\', \'t1\')', [assetId]);

    const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
    await upsertVulnerability({ cveId: 'CVE-2099-20001', cvssScore: 8.5 });
    await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', cveIds: ['CVE-2099-20001'], target: 't1' });
    await correlateJobObservations(orgId, jobId);

    const result = await syncSecurityGraph(orgId);
    expect(result.vulnerabilityNodes).toBe(1);

    const { rows } = await query(
      `SELECT e.edge_type FROM security_graph_edges e
         JOIN security_graph_nodes src ON src.id = e.source_node_id
         JOIN security_graph_nodes tgt ON tgt.id = e.target_node_id
        WHERE e.org_id = $1 AND src.ref_id = $2 AND tgt.node_type = 'VULNERABILITY'`,
      [orgId, assetId]
    );
    expect(rows[0].edge_type).toBe('AFFECTED_BY');
  });

  it('returns an empty list for an asset with no relationships', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const lonely = await makeAsset(orgId, userId, 'lonely', 'HOST');
    await syncSecurityGraph(orgId);
    expect(await findReachableAssets(orgId, lonely)).toEqual([]);
  });
});
