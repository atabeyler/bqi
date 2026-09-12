/**
 * Persistent job queue for IBM Quantum hardware verification.
 *
 * The scenario/fraud hardware-verification lane (see quantum.js's
 * verifyScenarioHardwareAsync / fraudDetection.js's verifyFraudHardwareAsync)
 * used to run as an in-memory, fire-and-forget async block directly inside
 * the /generate request handler: if the server process restarted (deploy,
 * crash) before IBM's job queue returned a result, that verification run
 * was silently lost with no record it was ever supposed to happen.
 *
 * This module persists each verification request as a row in
 * quantum_hardware_jobs before the request handler returns, and a
 * lightweight poller (startQuantumJobWorker) claims and processes pending
 * rows using `FOR UPDATE SKIP LOCKED` so multiple server instances can run
 * the same poller without double-processing a job. When DATABASE_URL isn't
 * configured, enqueueHardwareVerificationJob() returns null and the caller
 * falls back to the previous in-process behavior (see routes/analysis.js).
 */
import { query } from './database.js';
import { getDb, isDbConfigured } from '../db/client.js';
import { analyses } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { broadcastToUser } from './socket.js';
import { verifyScenarioHardwareAsync, buildScenarioHardwareSection } from './quantum.js';
import { verifyFraudHardwareAsync, buildFraudHardwareSection } from './fraudDetection.js';
import { verifyOptimizerHardwareAsync, buildOptimizerHardwareSection } from './portfolioOptimizer.js';

const POLL_MS = Number(process.env.QUANTUM_JOB_POLL_MS) || 5000;
const BATCH_SIZE = 3;
const MAX_ATTEMPTS = 2;
// A job claimed (status='processing') that never reaches completeJob/failJob
// -- e.g. the server process was killed mid-processJob, during the IBM
// hardware wait -- previously stayed 'processing' forever with no retry, so
// that report's hardware verification was silently lost. Any job still
// 'processing' after this long is treated as orphaned and reclaimed.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

export async function ensureQuantumJobTables() {
  if (!process.env.DATABASE_URL) return;
  await query(`
    CREATE TABLE IF NOT EXISTS quantum_hardware_jobs (
      id SERIAL PRIMARY KEY,
      analysis_id INTEGER,
      user_code VARCHAR(50) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_quantum_jobs_status ON quantum_hardware_jobs(status, created_at);`);
  logger.info('Quantum hardware job queue table ready');
}

/**
 * @param {{analysisId: number|null, userCode: string, kind: 'scenario'|'fraud', payload: Array}} job
 * @returns {Promise<number|null>} the job id, or null if DB isn't configured (caller should fall back)
 */
export async function enqueueHardwareVerificationJob({ analysisId, userCode, kind, payload }) {
  if (!process.env.DATABASE_URL || !userCode) return null;
  try {
    const { rows } = await query(
      `INSERT INTO quantum_hardware_jobs (analysis_id, user_code, kind, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [analysisId, userCode, kind, JSON.stringify(payload)]
    );
    return rows[0]?.id || null;
  } catch (err) {
    logger.warn({ err }, '[QuantumJobQueue] Failed to enqueue job');
    return null;
  }
}

async function reclaimStaleJobs() {
  // A 'processing' row past STALE_PROCESSING_MS never reached completeJob/
  // failJob (process crash/restart mid-job) -- put it back to 'pending' so
  // claimBatch picks it up again, counting it as one attempt so it can't
  // loop forever against a job that reliably crashes the worker.
  await query(
    `UPDATE quantum_hardware_jobs
     SET status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1, updated_at = NOW(),
         error = COALESCE(error, '') || ' [reclaimed after stale processing]'
     WHERE status = 'processing' AND updated_at < NOW() - ($1 || ' milliseconds')::interval`,
    [STALE_PROCESSING_MS, MAX_ATTEMPTS]
  );
}

async function claimBatch() {
  await reclaimStaleJobs().catch((err) => logger.warn({ err }, '[QuantumJobQueue] Failed to reclaim stale jobs'));
  const { rows } = await query(
    `UPDATE quantum_hardware_jobs SET status = 'processing', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM quantum_hardware_jobs
       WHERE status = 'pending' AND attempts < $1
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [MAX_ATTEMPTS, BATCH_SIZE]
  );
  return rows;
}

async function completeJob(id) {
  await query(`UPDATE quantum_hardware_jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`, [id]);
}

async function failJob(id, attempts, err) {
  const status = attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await query(
    `UPDATE quantum_hardware_jobs SET status = $1, attempts = $2, error = $3, updated_at = NOW() WHERE id = $4`,
    [status, attempts + 1, err?.message || String(err), id]
  );
}

async function processJob(job, io) {
  const hw = job.kind === 'scenario'
    ? await verifyScenarioHardwareAsync(job.payload)
    : job.kind === 'fraud'
      ? await verifyFraudHardwareAsync(job.payload)
      : await verifyOptimizerHardwareAsync(job.payload.items, job.payload.budgetPercent);

  if (!hw?.hardwareVerification) {
    await completeJob(job.id);
    return;
  }

  const section = job.kind === 'scenario'
    ? buildScenarioHardwareSection(job.payload, hw.hardwareVerification)
    : job.kind === 'fraud'
      ? buildFraudHardwareSection(hw.hardwareVerification)
      : buildOptimizerHardwareSection(hw.hardwareVerification);

  if (job.analysis_id && isDbConfigured() && section) {
    const db = getDb();
    const [current] = await db.select({ content: analyses.content }).from(analyses).where(eq(analyses.id, job.analysis_id));
    if (current) {
      await db.update(analyses)
        .set({
          content: current.content + section,
          version: sql`${analyses.version} + 1`,
          updatedAt: new Date(),
          syncRevision: sql`nextval('analyses_sync_revision_seq')`,
        })
        .where(eq(analyses.id, job.analysis_id));
    }
  }

  await broadcastToUser(io, job.user_code, 'analysis:hardwareVerified', {
    analysisId: job.analysis_id, kind: job.kind, hardwareVerification: hw.hardwareVerification, ibmDiagnostic: hw.ibmDiagnostic,
  }).catch(() => {});

  await completeJob(job.id);
}

let pollTimer = null;

/**
 * Starts the poller. Idempotent — a second call is a no-op so callers don't
 * need to track whether it's already running.
 */
let isPolling = false;

export function startQuantumJobWorker(io) {
  if (!process.env.DATABASE_URL || pollTimer) return;
  pollTimer = setInterval(async () => {
    // A single hardware job can take up to IBM_QUANTUM_WAIT_SECONDS (60s+),
    // far longer than POLL_MS (5s default) -- without this guard, every tick
    // during a long hardware wait re-enters claimBatch/processJob
    // concurrently, growing DB claim churn and in-flight job count
    // unbounded across that wait. Skipping overlapping ticks keeps at most
    // one batch in flight at a time.
    if (isPolling) return;
    isPolling = true;
    try {
      let jobs;
      try {
        jobs = await claimBatch();
      } catch (err) {
        logger.warn({ err }, '[QuantumJobQueue] Failed to claim jobs');
        return;
      }
      for (const job of jobs) {
        try {
          await processJob(job, io);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, '[QuantumJobQueue] Job failed');
          await failJob(job.id, job.attempts, err).catch(() => {});
        }
      }
    } finally {
      isPolling = false;
    }
  }, POLL_MS);
  pollTimer.unref();
  logger.info({ pollMs: POLL_MS }, '[QuantumJobQueue] Worker started');
}

export function stopQuantumJobWorker() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
