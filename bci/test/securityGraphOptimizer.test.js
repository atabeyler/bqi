import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { syncSecurityGraph } from '../src/services/securityGraph.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { upsertVulnerability } from '../src/services/intelligence.js';
import { computeAttackPathPriorities, computePatchOrder, identifyDefensiveControlPlacements } from '../src/services/securityGraphOptimizer.js';

beforeEach(resetDatabase);

async function makeAsset(orgId, userId, name, type, criticality = 'MEDIUM') {
  const { rows } = await query(
    'INSERT INTO assets (org_id, name, asset_type, criticality, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orgId, name, type, criticality, userId]
  );
  return rows[0].id;
}

async function makeVulnerableAsset(orgId, userId, name, criticality, cveId, cvssScore, identifierValue) {
  const assetId = await makeAsset(orgId, userId, name, 'HOST', criticality);
  await query("INSERT INTO asset_identifiers (asset_id, identifier_type, value) VALUES ($1, 'IP', $2)", [assetId, identifierValue]);
  const jobId = (await query(
    `INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,$3,'PASSIVE') RETURNING id`,
    [orgId, userId, identifierValue]
  )).rows[0].id;
  await upsertVulnerability({ cveId, cvssScore });
  await insertNormalizedObservation(orgId, jobId, { engineId: 'trivy', cveIds: [cveId], target: identifierValue });
  await correlateJobObservations(orgId, jobId);
  return assetId;
}

describe('computeAttackPathPriorities', () => {
  it('ranks a CVE with critical assets in its blast radius above one with none', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const dangerousEntry = await makeVulnerableAsset(orgId, userId, 'edge-1', 'MEDIUM', 'CVE-2099-30001', 9.0, 't-edge-1');
    const criticalApp = await makeAsset(orgId, userId, 'payments', 'WEB_APP', 'CRITICAL');
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'HOSTS')", [orgId, dangerousEntry, criticalApp]);

    await makeVulnerableAsset(orgId, userId, 'isolated-1', 'MEDIUM', 'CVE-2099-30002', 9.5, 't-isolated-1');

    await syncSecurityGraph(orgId);
    const priorities = await computeAttackPathPriorities(orgId);

    expect(priorities).toHaveLength(2);
    expect(priorities[0].cveId).toBe('CVE-2099-30001');
    expect(priorities[0].criticalBlastRadiusCount).toBe(1);
    expect(priorities[0].criticalAssetsAtRisk[0].label).toBe('payments');

    const isolated = priorities.find((p) => p.cveId === 'CVE-2099-30002');
    expect(isolated.criticalBlastRadiusCount).toBe(0);
    expect(priorities[0].priorityScore).toBeGreaterThan(isolated.priorityScore);
  });

  it('returns an empty list when the graph has no vulnerable assets', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await makeAsset(orgId, userId, 'clean-host', 'HOST');
    await syncSecurityGraph(orgId);
    expect(await computeAttackPathPriorities(orgId)).toEqual([]);
  });
});

describe('computePatchOrder', () => {
  it('produces a ranked, human-readable order matching the attack-path priorities', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const entry = await makeVulnerableAsset(orgId, userId, 'edge-2', 'MEDIUM', 'CVE-2099-30003', 8.0, 't-edge-2');
    const criticalApp = await makeAsset(orgId, userId, 'db', 'CLOUD_RESOURCE', 'CRITICAL');
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'DEPENDS_ON')", [orgId, entry, criticalApp]);

    await syncSecurityGraph(orgId);
    const order = await computePatchOrder(orgId);

    expect(order[0].rank).toBe(1);
    expect(order[0].cveId).toBe('CVE-2099-30003');
    expect(order[0].reason).toMatch(/critical\/high-criticality asset/);
  });
});

describe('identifyDefensiveControlPlacements', () => {
  it('scores an intermediate node higher when multiple attack paths pass through it toward critical assets', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    // Two independent vulnerable entry points both route through the same
    // gateway host before reaching two different critical assets.
    const gateway = await makeAsset(orgId, userId, 'gateway', 'HOST', 'MEDIUM');
    const entryA = await makeVulnerableAsset(orgId, userId, 'entry-a', 'LOW', 'CVE-2099-30010', 7.0, 't-entry-a');
    const entryB = await makeVulnerableAsset(orgId, userId, 'entry-b', 'LOW', 'CVE-2099-30011', 7.5, 't-entry-b');
    const criticalA = await makeAsset(orgId, userId, 'critical-a', 'WEB_APP', 'CRITICAL');
    const criticalB = await makeAsset(orgId, userId, 'critical-b', 'WEB_APP', 'HIGH');

    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'CONNECTS_TO')", [orgId, entryA, gateway]);
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'CONNECTS_TO')", [orgId, entryB, gateway]);
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'HOSTS')", [orgId, gateway, criticalA]);
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'HOSTS')", [orgId, gateway, criticalB]);

    await syncSecurityGraph(orgId);
    const placements = await identifyDefensiveControlPlacements(orgId);

    expect(placements[0].assetId).toBe(gateway);
    expect(placements[0].attackPathsThrough).toBe(4); // 2 entries x 2 critical destinations
    expect(placements[0].protectsCriticalAssetCount).toBe(2);
  });

  it('never proposes a vulnerable entry point or the critical destination itself as the control placement', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const entry = await makeVulnerableAsset(orgId, userId, 'direct-entry', 'MEDIUM', 'CVE-2099-30020', 8.0, 't-direct-entry');
    const criticalApp = await makeAsset(orgId, userId, 'direct-critical', 'WEB_APP', 'CRITICAL');
    // Direct edge -- no intermediate hop exists on this path at all.
    await query("INSERT INTO asset_relationships (org_id, source_asset_id, target_asset_id, relationship_type) VALUES ($1,$2,$3,'HOSTS')", [orgId, entry, criticalApp]);

    await syncSecurityGraph(orgId);
    const placements = await identifyDefensiveControlPlacements(orgId);
    expect(placements.map((p) => p.assetId)).not.toContain(entry);
    expect(placements.map((p) => p.assetId)).not.toContain(criticalApp);
    expect(placements).toEqual([]);
  });
});
