import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import { createRemediation, updateRemediationStatus, listRemediationsForFinding } from '../src/services/remediation.js';

beforeEach(resetDatabase);

async function seedFinding() {
  const orgId = await createOrg();
  const userId = await createUser(orgId, { roleId: 'operator' });
  const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
  await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });
  const [findingId] = await correlateJobObservations(orgId, jobId);
  return { orgId, userId, findingId };
}

describe('remediation lifecycle', () => {
  it('assigning a remediation moves a NEW finding to ASSIGNED', async () => {
    const { orgId, userId, findingId } = await seedFinding();
    await createRemediation({ orgId, actorUserId: userId, findingId, recommendation: 'upgrade lodash', assigneeUserId: userId });

    const { rows } = await query('SELECT status FROM findings WHERE id = $1', [findingId]);
    expect(rows[0].status).toBe('ASSIGNED');
  });

  it('moving a remediation to DONE moves the finding to READY_FOR_VERIFICATION', async () => {
    const { orgId, userId, findingId } = await seedFinding();
    const remediation = await createRemediation({ orgId, actorUserId: userId, findingId, recommendation: 'fix it' });
    await updateRemediationStatus({ orgId, actorUserId: userId, remediationId: remediation.id, status: 'DONE' });

    const { rows } = await query('SELECT status FROM findings WHERE id = $1', [findingId]);
    expect(rows[0].status).toBe('READY_FOR_VERIFICATION');
  });

  it('lists remediations for a finding, most recent first', async () => {
    const { orgId, userId, findingId } = await seedFinding();
    await createRemediation({ orgId, actorUserId: userId, findingId, recommendation: 'first' });
    await createRemediation({ orgId, actorUserId: userId, findingId, recommendation: 'second' });

    const list = await listRemediationsForFinding(orgId, findingId);
    expect(list).toHaveLength(2);
    expect(list[0].recommendation).toBe('second');
  });

  it('updating a remediation from a different org fails (cross-tenant isolation)', async () => {
    const { userId, findingId } = await seedFinding();
    const otherOrgId = await createOrg('Other', 'other-org');
    const remediation = await createRemediation({ orgId: (await query('SELECT org_id FROM findings WHERE id=$1',[findingId])).rows[0].org_id, actorUserId: userId, findingId, recommendation: 'x' });

    const result = await updateRemediationStatus({ orgId: otherOrgId, actorUserId: userId, remediationId: remediation.id, status: 'DONE' });
    expect(result).toBeNull();
  });
});
