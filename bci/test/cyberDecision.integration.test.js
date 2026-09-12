import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/client.js';
import { createOrg, createUser, resetDatabase, seedEngine } from './helpers/db.js';
import { analyzePostureSnapshot } from '../src/engines/adapters/postureIntelligence.js';
import { ingestPostureEnvelope } from '../src/services/postureIntelligence.js';
import { storeRawObservation, normalizeStoredObservation } from '../src/services/normalization.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { mapEvidenceBackedTechniques } from '../src/services/attackMapping.js';
import { getKnowledgeGraph, syncSecurityGraph } from '../src/services/securityGraph.js';
import { loadDigitalTwin } from '../src/services/cyberDecision.js';
import { comparePostureSnapshots } from '../src/services/postureDrift.js';

beforeEach(resetDatabase);

async function seedJob(orgId, userId, target = '123456789012') {
  await seedEngine('bci-posture-intelligence');
  const { rows } = await query(
    `INSERT INTO scan_jobs (org_id, requested_by, target, target_type, requested_class)
     VALUES ($1,$2,$3,'CLOUD_ACCOUNT','PASSIVE') RETURNING id`,
    [orgId, userId, target]
  );
  return rows[0].id;
}

function makeSnapshot(collectedAt, overrides = {}) {
  return {
    schemaVersion: '1.0', source: 'test-collector', collectedAt,
    entities: [
      { type: 'CLOUD_ACCOUNT', key: '123456789012', attributes: { logging: true } },
      { type: 'IDENTITY', key: 'admin', attributes: { interactive: true, mfa: false, password: 'never-store-me', ...overrides } },
    ],
    relationships: [{ sourceType: 'IDENTITY', sourceKey: 'admin', targetType: 'CLOUD_ACCOUNT', targetKey: '123456789012', type: 'CAN_ACCESS', evidence: {} }],
    controls: [{ key: 'mfa-control', type: 'MFA', status: 'INEFFECTIVE', effectiveness: 0, protects: [{ entityType: 'IDENTITY', entityKey: 'admin' }], evidence: {} }],
  };
}

describe('Cyber Decision Intelligence persistence', () => {
  it('persists redacted posture evidence through correlation and Graph V2', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const jobId = await seedJob(orgId, userId);
    const envelope = analyzePostureSnapshot(makeSnapshot('2026-09-09T06:00:00.000Z'));
    await ingestPostureEnvelope({ orgId, jobId, target: '123456789012', targetType: 'CLOUD_ACCOUNT', envelope });
    const rawId = await storeRawObservation({ orgId, jobId, engineId: 'bci-posture-intelligence', target: '123456789012', payload: envelope });
    await normalizeStoredObservation(rawId);
    const findingIds = await correlateJobObservations(orgId, jobId);
    await mapEvidenceBackedTechniques(orgId, findingIds);
    await syncSecurityGraph(orgId);

    const { rows: identities } = await query("SELECT attributes FROM cyber_entities WHERE org_id = $1 AND entity_type = 'IDENTITY'", [orgId]);
    expect(identities[0].attributes.password).toBe('[REDACTED]');
    const graph = await getKnowledgeGraph(orgId);
    expect(graph.nodes.map((node) => node.node_type)).toEqual(expect.arrayContaining(['IDENTITY', 'CONTROL', 'FINDING', 'EVIDENCE', 'ATTACK_TECHNIQUE']));
    expect(graph.edges.map((edge) => edge.edge_type)).toEqual(expect.arrayContaining(['CAN_ACCESS', 'PROTECTS', 'HAS_FINDING', 'SUPPORTS', 'EXPLAINS']));
  });

  it('keeps digital-twin data tenant isolated', async () => {
    const orgA = await createOrg('A', 'a');
    const userA = await createUser(orgA, { email: 'a@example.com', roleId: 'operator' });
    const jobA = await seedJob(orgA, userA);
    await ingestPostureEnvelope({ orgId: orgA, jobId: jobA, target: '123456789012', targetType: 'CLOUD_ACCOUNT', envelope: analyzePostureSnapshot(makeSnapshot('2026-09-09T06:00:00.000Z')) });

    const orgB = await createOrg('B', 'b');
    const twinB = await loadDigitalTwin(orgB);
    expect(twinB.entities).toEqual([]);
    expect(twinB.controls).toEqual([]);
  });

  it('compares two stored snapshots of the same target', async () => {
    const orgId = await createOrg('Drift', 'drift');
    const userId = await createUser(orgId, { email: 'drift@example.com', roleId: 'operator' });
    const firstJob = await seedJob(orgId, userId);
    const first = await ingestPostureEnvelope({ orgId, jobId: firstJob, target: '123456789012', targetType: 'CLOUD_ACCOUNT', envelope: analyzePostureSnapshot(makeSnapshot('2026-09-01T06:00:00.000Z')) });
    const secondJob = await seedJob(orgId, userId);
    const second = await ingestPostureEnvelope({ orgId, jobId: secondJob, target: '123456789012', targetType: 'CLOUD_ACCOUNT', envelope: analyzePostureSnapshot(makeSnapshot('2026-09-09T06:00:00.000Z', { permissions: ['*'] })) });
    const drift = await comparePostureSnapshots(orgId, first.snapshotId, second.snapshotId);
    expect(drift.securityRegression).toBe(true);
    expect(drift.newPrivileges).toContain('IDENTITY:admin');
  });
});
