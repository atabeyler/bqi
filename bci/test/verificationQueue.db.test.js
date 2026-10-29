import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, insertNormalizedObservation } from './helpers/db.js';
import { correlateJobObservations } from '../src/services/correlation.js';
import {
  enqueueVerification, claimNextVerification, completeVerification, waitForVerification, runVerificationJob,
} from '../src/services/verificationQueue.js';

beforeEach(resetDatabase);

async function seed() {
  const orgId = await createOrg();
  const userId = (await query('INSERT INTO users (org_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [orgId, `q-${Math.random()}@x.com`, 'x'])).rows[0].id;
  const jobId = (await query(`INSERT INTO scan_jobs (org_id, requested_by, target, requested_class) VALUES ($1,$2,'t1','PASSIVE') RETURNING id`, [orgId, userId])).rows[0].id;
  await insertNormalizedObservation(orgId, jobId, { engineId: 'semgrep', ruleId: 'eval-detected', location: 'app.js:7', target: 't1' });
  const [findingId] = await correlateJobObservations(orgId, jobId);
  return { orgId, userId, findingId };
}

describe('verification queue (real database)', () => {
  it('hands a queued verification to exactly one worker and returns its outcome to the waiting API call', async () => {
    const { orgId, userId, findingId } = await seed();
    const id = await enqueueVerification({ orgId, actorUserId: userId, findingId });

    const [a, b] = await Promise.all([claimNextVerification('worker-a'), claimNextVerification('worker-b')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((a || b).id).toBe(id);

    const waiting = waitForVerification(id, { timeoutMs: 5000, pollMs: 20 });
    await completeVerification(id, { result: 'FIX_VERIFIED', detail: 'ok' });
    await expect(waiting).resolves.toEqual({ result: 'FIX_VERIFIED', detail: 'ok' });
  });

  it('times out with null while nobody works the job, and re-claims a job whose worker died', async () => {
    const { orgId, userId, findingId } = await seed();
    const id = await enqueueVerification({ orgId, actorUserId: userId, findingId });
    await expect(waitForVerification(id, { timeoutMs: 60, pollMs: 10 })).resolves.toBeNull();

    await claimNextVerification('dead-worker');
    expect(await claimNextVerification('other-worker')).toBeNull();
    await query(`UPDATE verification_jobs SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect((await claimNextVerification('other-worker')).id).toBe(id);
  });

  it('records the verifier result on the job and survives the verifier throwing', async () => {
    const { orgId, userId, findingId } = await seed();
    const id = await enqueueVerification({ orgId, actorUserId: userId, findingId });
    const job = await claimNextVerification('worker-a');
    const outcome = await runVerificationJob(job, async () => { throw new Error('boom'); });
    expect(outcome.result).toBe('INCONCLUSIVE');
    const { rows } = await query('SELECT status, outcome FROM verification_jobs WHERE id = $1', [id]);
    expect(rows[0].status).toBe('DONE');
    expect(rows[0].outcome.detail).toContain('boom');
  });
});
