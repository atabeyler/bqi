import { query } from '../db/client.js';
import { verifyFix } from './verify.js';

// A verification that never finishes must not hang the caller: the BQI gateway allows 120 s.
export const VERIFICATION_WAIT_MS = 90_000;
const POLL_MS = 500;
// A RUNNING row this old belongs to a worker that died mid-run; it is picked up again.
const STALE_RUNNING_SECONDS = 180;

export async function enqueueVerification({ orgId, actorUserId, findingId }) {
  const { rows } = await query(
    'INSERT INTO verification_jobs (org_id, finding_id, requested_by) VALUES ($1, $2, $3) RETURNING id',
    [orgId, findingId, actorUserId]
  );
  return rows[0].id;
}

export async function waitForVerification(jobId, { timeoutMs = VERIFICATION_WAIT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query('SELECT status, outcome FROM verification_jobs WHERE id = $1', [jobId]);
    if (rows[0]?.status === 'DONE') return rows[0].outcome;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function claimNextVerification(workerId) {
  const { rows } = await query(
    `UPDATE verification_jobs SET status = 'RUNNING', locked_by = $1, updated_at = now()
      WHERE id = (
        SELECT id FROM verification_jobs
         WHERE status = 'QUEUED' OR (status = 'RUNNING' AND updated_at < now() - make_interval(secs => $2))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING *`,
    [workerId, STALE_RUNNING_SECONDS]
  );
  return rows[0] || null;
}

export async function completeVerification(jobId, outcome) {
  await query(
    `UPDATE verification_jobs SET status = 'DONE', outcome = $1, locked_by = NULL, updated_at = now() WHERE id = $2`,
    [JSON.stringify(outcome), jobId]
  );
}

// Runs one claimed job in the worker. verifyFix already records the verification run and audit event.
export async function runVerificationJob(job, run = verifyFix) {
  let outcome;
  try {
    outcome = await run(job.org_id, job.requested_by, job.finding_id);
    if (!outcome) outcome = { result: 'INCONCLUSIVE', detail: 'finding no longer exists' };
  } catch (err) {
    outcome = { result: 'INCONCLUSIVE', detail: `verification failed: ${String(err?.message || err)}` };
  }
  await completeVerification(job.id, outcome);
  return outcome;
}

// Called from the worker loop; returns true when a job was handled so the loop can skip its idle sleep.
export async function processNextVerification(workerId) {
  const job = await claimNextVerification(workerId);
  if (!job) return false;
  await runVerificationJob(job);
  return true;
}
