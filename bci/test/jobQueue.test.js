import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import {
  enqueueScan,
  claimNextJob,
  completeJob,
  markNoCoverage,
  failJob,
  cancelJob,
  sweepTimedOutJobs,
  resolveJobTimeoutMs,
} from '../src/services/jobQueue.js';

// Preflight reads live engine_health. Seed deterministic statuses here so
// queue-policy tests do not depend on which scanner binaries are installed.
beforeEach(async () => {
  await resetDatabase();
  for (const engineId of ['semgrep', 'osv-scanner', 'trivy', 'nuclei', 'http-fuzz']) {
    await query(
      `INSERT INTO engine_health (engine_id, status, last_checked_at) VALUES ($1, 'HEALTHY', now())
       ON CONFLICT (engine_id) DO UPDATE SET status = 'HEALTHY', last_checked_at = now()`,
      [engineId]
    );
  }
});

async function approveScope(orgId, userId, target, allowedScanClasses = ['PASSIVE'], targetType = 'DOMAIN') {
  const { rows } = await query(
    `INSERT INTO authorized_scopes (org_id, name, target, target_type, allowed_scan_classes, status, created_by, approved_by, approved_at)
     VALUES ($1, 'scope', $2, $3, $4, 'APPROVED', $5, $5, now()) RETURNING id`,
    [orgId, target, targetType, allowedScanClasses, userId]
  );
  return rows[0].id;
}

describe('job queue', () => {
  it('does not impose a worker timeout on a user-stoppable durationless UNLIMITED resilience job', () => {
    expect(resolveJobTimeoutMs({ engine_options: { 'availability-probe': { requestedPlan: { requestCountMode: 'UNLIMITED', durationMs: null } } } })).toBeNull();
  });

  it('sizes a finite resilience worker timeout from the requested duration instead of the former 45-second cap', () => {
    const timeout = resolveJobTimeoutMs({ engine_options: { 'availability-probe': { requestedPlan: { requestCountMode: '10000', durationMs: 600_000, requestTimeoutMs: 20_000 } } } });
    expect(timeout).toBeGreaterThan(600_000);
  });

  it('rejects before queueing when target/class has no executable engine', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const outcome = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'PASSIVE' });
    expect(outcome.accepted).toBe(false);
    expect(outcome.decision.reason).toBe('no_executable_engine');
  });

  it('with no selectedEngineIds, defaults selected_engine_ids to the full real recommended plan (unchanged pre-existing behavior)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '/tmp/some-repo', ['PASSIVE'], 'REPOSITORY');

    const outcome = await enqueueScan({ orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE' });
    expect(outcome.accepted).toBe(true);
    expect(outcome.job.recommended_engine_ids.sort()).toEqual(['osv-scanner', 'semgrep', 'trivy']);
    expect(outcome.job.selected_engine_ids.sort()).toEqual(['osv-scanner', 'semgrep', 'trivy']);
  });

  it('accepts a real subset of the recommended engines as selectedEngineIds', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '/tmp/some-repo', ['PASSIVE'], 'REPOSITORY');

    const outcome = await enqueueScan({
      orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedEngineIds: ['semgrep'], selectedCapabilities: ['SAST'],
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.job.selected_engine_ids).toEqual(['semgrep']);
    expect(outcome.job.recommended_engine_ids.sort()).toEqual(['osv-scanner', 'semgrep', 'trivy']); // recommendation itself unchanged
  });

  it('rejects a selectedEngineIds entry that is not compatible/recommended for this target type -- never silently ignored, never allowed to add scope', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '/tmp/some-repo', ['PASSIVE'], 'REPOSITORY');

    // nuclei is a DOMAIN/WEB engine, never recommended for REPOSITORY.
    const outcome = await enqueueScan({
      orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedEngineIds: ['nuclei'], selectedCapabilities: ['SAST'],
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.decision.reason).toBe('engine_not_compatible');

    const { rows } = await query('SELECT count(*)::int AS n FROM scan_jobs');
    expect(rows[0].n).toBe(0); // no job created on rejection
  });

  it('rejects an empty selectedEngineIds array -- at least one engine is required if a selection is made at all', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '/tmp/some-repo', ['PASSIVE'], 'REPOSITORY');

    const outcome = await enqueueScan({
      orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedEngineIds: [], selectedCapabilities: ['SAST'],
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.decision.reason).toBe('at_least_one_engine_required');
  });

  it('rejects a selected engine that is compatible/recommended but not actually HEALTHY', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, '/tmp/some-repo', ['PASSIVE'], 'REPOSITORY');
    await query(
      `INSERT INTO engine_health (engine_id, status, last_checked_at) VALUES ('semgrep', 'OFFLINE', now())
       ON CONFLICT (engine_id) DO UPDATE SET status = 'OFFLINE', last_checked_at = now()`
    );

    const outcome = await enqueueScan({
      orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedEngineIds: ['semgrep'], selectedCapabilities: ['SAST'],
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.decision.reason).toBe('engine_not_healthy');
  });

  it('rejects unknown or unavailable capabilities before creating a job', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const unknown = await enqueueScan({ orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedCapabilities: ['NOT_REAL'] });
    expect(unknown.accepted).toBe(false);
    expect(unknown.decision.reason).toBe('unknown_capability');

    const unavailable = await enqueueScan({ orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE', selectedCapabilities: ['FUZZ'] });
    expect(unavailable.accepted).toBe(false);
    expect(unavailable.decision.reason).toBe('capability_unavailable');
    expect((await query('SELECT count(*)::int AS n FROM scan_jobs')).rows[0].n).toBe(0);
  });

  it('rejects an engine subset that does not cover every selected capability', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    const outcome = await enqueueScan({
      orgId, actorUserId: userId, target: '/tmp/some-repo', requestedClass: 'PASSIVE',
      selectedCapabilities: ['SAST', 'SCA'], selectedEngineIds: ['semgrep'],
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.decision.reason).toBe('selected_engines_do_not_cover_capabilities');
    expect(outcome.decision.uncoveredCapabilities).toEqual(['SCA']);
  });

  it('claimNextJob moves a job to ANALYZING and stamps a timeout', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });

    const claimed = await claimNextJob('worker-1');
    expect(claimed.id).toBe(job.id);
    expect(claimed.status).toBe('ANALYZING');
    expect(claimed.attempts).toBe(1);
    expect(claimed.timeout_at).not.toBeNull();
  });

  it('two workers claiming concurrently never get the same job', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });

    const [a, b] = await Promise.all([claimNextJob('worker-a'), claimNextJob('worker-b')]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('completeJob marks the job COMPLETED with a result payload', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    await claimNextJob('worker-1');

    await completeJob(job.id, { ok: true });
    const { rows } = await query('SELECT status, result FROM scan_jobs WHERE id = $1', [job.id]);
    expect(rows[0].status).toBe('COMPLETED');
    expect(rows[0].result).toEqual({ ok: true });
  });

  it('markNoCoverage marks the job NO_COVERAGE, distinct from COMPLETED, when the pipeline ran zero engines', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    await claimNextJob('worker-1');

    await markNoCoverage(job.id, { enginesRun: [], note: 'no engine coverage for target type DOMAIN' });
    const { rows } = await query('SELECT status, result FROM scan_jobs WHERE id = $1', [job.id]);
    expect(rows[0].status).toBe('NO_COVERAGE');
    expect(rows[0].status).not.toBe('COMPLETED');
    expect(rows[0].result.note).toMatch(/no engine coverage/);
  });

  it('failJob requeues until max_attempts, then marks FAILED for good', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    await query('UPDATE scan_jobs SET max_attempts = 2 WHERE id = $1', [job.id]);

    await claimNextJob('worker-1'); // attempt 1
    await failJob(job.id, 'boom');
    let { rows } = await query('SELECT status, attempts FROM scan_jobs WHERE id = $1', [job.id]);
    expect(rows[0].status).toBe('QUEUED');
    expect(rows[0].attempts).toBe(1);

    await claimNextJob('worker-1'); // attempt 2
    await failJob(job.id, 'boom again');
    ({ rows } = await query('SELECT status FROM scan_jobs WHERE id = $1', [job.id]));
    expect(rows[0].status).toBe('FAILED');
  });

  it('cancelJob stops a QUEUED job but not an already-terminal one', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });

    const cancelled = await cancelJob({ orgId, actorUserId: userId, jobId: job.id });
    expect(cancelled.status).toBe('CANCELLED');

    const again = await cancelJob({ orgId, actorUserId: userId, jobId: job.id });
    expect(again).toBeNull();
  });

  it('sweepTimedOutJobs requeues a stuck job within its attempt budget and TIMED_OUTs it once exhausted', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });
    await approveScope(orgId, userId, 'example.com');
    const { job } = await enqueueScan({ orgId, actorUserId: userId, target: 'example.com', requestedClass: 'SAFE_ACTIVE' });
    await query('UPDATE scan_jobs SET max_attempts = 1 WHERE id = $1', [job.id]);

    await claimNextJob('worker-1');
    // Simulate a worker that crashed mid-job: force the timeout into the past.
    await query("UPDATE scan_jobs SET timeout_at = now() - interval '1 minute' WHERE id = $1", [job.id]);

    const swept = await sweepTimedOutJobs();
    expect(swept).toBe(1);

    const { rows } = await query('SELECT status FROM scan_jobs WHERE id = $1', [job.id]);
    expect(rows[0].status).toBe('TIMED_OUT');
  });
});
