import { pool, query } from '../db/client.js';
import { evaluateScopeAuthorization } from './policyEngine.js';
import { recordAuditEvent } from './audit.js';
import { availableCapabilitiesForTargetType, planEngines } from './analysisPlanner.js';
import { getEngineCatalog } from '../engines/registry.js';
import { getCapability } from '../engines/capabilities.js';
import { resolveExecutionMode } from '../quantum/executionPolicy.js';
import { normalizeTargetForExecution } from '../lib/targetMatcher.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const NUCLEI_JOB_TIMEOUT_MS = Object.freeze({
  BCI_BUNDLED: 5 * 60_000,
  STANDARD: 12 * 60_000,
  EXTENDED: 22 * 60_000,
  FULL_SAFE: 32 * 60_000,
});
const ENGINE_JOB_BUDGET_MS = Object.freeze({
  naabu: 5 * 60_000,
  'http-fuzz': 10 * 60_000,
  'intrusive-validation': 10 * 60_000,
});
const RESILIENCE_ROUND_BUDGET = 30; // registry rounds are sequential; this is timeout sizing, never a load-plan cap

export function resolveJobTimeoutMs(job, explicitTimeoutMs) {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  const nuclei = job?.engine_options?.nuclei;
  const nucleiTimeout = nuclei ? (NUCLEI_JOB_TIMEOUT_MS[nuclei.scanProfile || 'STANDARD'] || DEFAULT_TIMEOUT_MS) : 0;
  const plan = job?.engine_options?.['availability-probe']?.requestedPlan;
  const selectedEngines = Array.isArray(job?.selected_engine_ids) ? job.selected_engine_ids : [];
  const multiEngineBudget = selectedEngines.reduce((total, engineId) => {
    if (engineId === 'nuclei') return total + (nucleiTimeout || NUCLEI_JOB_TIMEOUT_MS.STANDARD);
    return total + (ENGINE_JOB_BUDGET_MS[engineId] || DEFAULT_TIMEOUT_MS);
  }, 0);
  const boundedEngineBudget = Math.max(DEFAULT_TIMEOUT_MS, multiEngineBudget || nucleiTimeout);
  if (!plan) return boundedEngineBudget;
  if (plan.requestCountMode === 'UNLIMITED' && plan.durationMs == null) return null;

  const estimatedRoundMs = plan.durationMs
    ?? (plan.totalRequests && plan.targetRps ? Math.ceil((plan.totalRequests / plan.targetRps) * 1000) : 0);
  if (!estimatedRoundMs) return boundedEngineBudget;
  const resilienceBudget = (estimatedRoundMs + (plan.requestTimeoutMs ?? 5000)) * RESILIENCE_ROUND_BUDGET;
  return Math.max(DEFAULT_TIMEOUT_MS, boundedEngineBudget + resilienceBudget);
}

// selectedEngineIds (optional) is the wizard's real per-job engine choice
// (spec: "BCI ÖNERİR -> KULLANICI SEÇER -> SEÇİLEN MOTORLAR GERÇEKTEN
// ÇALIŞIR"). It is validated against analysisPlanner.js's own real
// recommendation for this target type + class -- never trusted as an
// arbitrary engine id list -- so a caller can narrow the recommended plan
// (skip an engine it doesn't want run) but can never add an incompatible
// or unhealthy one. Omitted entirely (the pre-existing quick-scan path),
// it defaults to the full recommended plan, identical to today's behavior.
export async function enqueueScan({ orgId, actorUserId, target, requestedClass, selectedEngineIds, selectedCapabilities, selectedComputeMode, engineOptions }) {
  for (const engineId of ['http-fuzz', 'intrusive-validation']) {
    if (engineOptions?.[engineId]?.engagementId) {
      if (requestedClass !== 'RESTRICTED') return { accepted: false, decision: { reason: 'pentest_requires_restricted_class' } };
      const { loadPentestContext } = await import('./pentest.js');
      await loadPentestContext(orgId, engineOptions[engineId].engagementId, target);
    }
  }
  const normalizedTarget = normalizeTargetForExecution(target);
  const { targetType } = await evaluateScopeAuthorization({ orgId, actorUserId, target: normalizedTarget, requestedClass });

  const hasPostureSnapshot = Boolean(engineOptions?.['bci-posture-intelligence']?.snapshot);
  const executionEligible = (plan) => plan.engineId !== 'bci-posture-intelligence' || hasPostureSnapshot;

  const catalog = await getEngineCatalog();
  const healthyIds = new Set(catalog.filter((engine) => engine.status === 'HEALTHY').map((engine) => engine.id));
  const recommended = planEngines(targetType, requestedClass).filter(executionEligible);
  const recommendedIds = recommended.map((plan) => plan.engineId);
  const recommendedCapabilityIds = [...new Set(recommended.flatMap((plan) => plan.capabilities))];
  const capabilityCatalog = availableCapabilitiesForTargetType(targetType, requestedClass, catalog);
  const supportedCapabilityIds = capabilityCatalog
    .filter((capability) => capability.supported)
    .map((capability) => capability.id);
  const availableCapabilityIds = capabilityCatalog
    .filter((capability) => capability.available)
    .filter((capability) => hasPostureSnapshot || capability.executableEngineIds.some((engineId) => engineId !== 'bci-posture-intelligence'))
    .map((capability) => capability.id);

  let selectedCapabilityIds = availableCapabilityIds;
  if (selectedCapabilities !== undefined) {
    if (!Array.isArray(selectedCapabilities) || selectedCapabilities.length === 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'at_least_one_capability_required' } };
    }
    selectedCapabilityIds = [...new Set(selectedCapabilities.map((id) => String(id).toUpperCase()))];
    const unknown = selectedCapabilityIds.filter((id) => !getCapability(id));
    if (unknown.length > 0) return { accepted: false, decision: { decision: 'DENY', reason: 'unknown_capability', invalidCapabilities: unknown } };
    const unavailable = selectedCapabilityIds.filter((id) => !supportedCapabilityIds.includes(id));
    if (unavailable.length > 0) return { accepted: false, decision: { decision: 'DENY', reason: 'capability_unavailable', unavailableCapabilities: unavailable } };
    if (!hasPostureSnapshot) {
      const snapshotOnly = planEngines(targetType, requestedClass, selectedCapabilityIds)
        .filter((plan) => plan.engineId === 'bci-posture-intelligence')
        .flatMap((plan) => plan.capabilities);
      if (snapshotOnly.length > 0) {
        return { accepted: false, decision: { decision: 'DENY', reason: 'posture_snapshot_required', unavailableCapabilities: [...new Set(snapshotOnly)] } };
      }
    }
  }

  const compatibleCapabilityPlan = planEngines(targetType, requestedClass, selectedCapabilityIds).filter(executionEligible);
  const capabilityPlan = compatibleCapabilityPlan.filter((plan) => healthyIds.has(plan.engineId));
  const capabilityPlanIds = capabilityPlan.map((plan) => plan.engineId);

  let selected = capabilityPlanIds;
  if (selectedEngineIds !== undefined) {
    if (!Array.isArray(selectedEngineIds) || selectedEngineIds.length === 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'at_least_one_engine_required' } };
    }
    const compatibleCapabilityPlanIds = compatibleCapabilityPlan.map((plan) => plan.engineId);
    const invalid = selectedEngineIds.filter((id) => !compatibleCapabilityPlanIds.includes(id));
    if (invalid.length > 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'engine_not_compatible', invalidEngineIds: invalid } };
    }
    const unhealthy = selectedEngineIds.filter((id) => catalog.find((e) => e.id === id)?.status !== 'HEALTHY');
    if (unhealthy.length > 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'engine_not_healthy', unhealthyEngineIds: unhealthy } };
    }
    const uncovered = selectedCapabilityIds.filter((capabilityId) => !selectedEngineIds.some((engineId) => compatibleCapabilityPlan.find((plan) => plan.engineId === engineId)?.capabilities.includes(capabilityId)));
    if (uncovered.length > 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'selected_engines_do_not_cover_capabilities', uncoveredCapabilities: uncovered } };
    }
    selected = selectedEngineIds;
  } else {
    const unavailable = selectedCapabilityIds.filter((capabilityId) => !capabilityPlan.some((plan) => plan.capabilities.includes(capabilityId)));
    if (unavailable.length > 0) {
      return { accepted: false, decision: { decision: 'DENY', reason: 'capability_unavailable', unavailableCapabilities: unavailable } };
    }
  }

  if (selected.length === 0) {
    return { accepted: false, decision: { decision: 'DENY', reason: 'no_executable_engine', targetType, requestedClass } };
  }

  // Real policy+health-driven recommendation (executionPolicy.js's actual
  // fallback chain), just without a real problem size yet -- findings don't
  // exist until the scan itself runs, so this can only reflect current
  // policy/provider health, not a size-aware decision. The real,
  // size-aware actual_mode + fallback_reason are only known once
  // remediation-optimize genuinely runs against this job's findings (see
  // quantum/benchmark.js) -- this is BCI's informational suggestion at
  // Wizard step 3, not a claim about what will execute.
  const recommendedComputeMode = (await resolveExecutionMode({ orgId, problemSize: 1, dataClassification: 'INTERNAL' })).mode;

  // Only real, already-selected engine ids may carry options -- an
  // engineOptions entry for an engine this job isn't even running is
  // dropped rather than silently stored as dead/confusing data.
  const sanitizedEngineOptions = engineOptions && typeof engineOptions === 'object'
    ? Object.fromEntries(Object.entries(engineOptions).filter(([engineId]) => selected.includes(engineId)))
    : null;

  const { rows } = await query(
    `INSERT INTO scan_jobs (
       org_id, requested_by, target, requested_class, scope_id, target_type,
       recommended_engine_ids, selected_engine_ids, recommended_capability_ids, selected_capability_ids,
       recommended_compute_mode, selected_compute_mode, engine_options
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, status, created_at, recommended_engine_ids, selected_engine_ids,
       recommended_capability_ids, selected_capability_ids, recommended_compute_mode, selected_compute_mode, engine_options`,
    [
      orgId, actorUserId, normalizedTarget, requestedClass, null, targetType, recommendedIds, selected, recommendedCapabilityIds, selectedCapabilityIds,
      recommendedComputeMode, selectedComputeMode ?? null,
      sanitizedEngineOptions && Object.keys(sanitizedEngineOptions).length > 0 ? JSON.stringify(sanitizedEngineOptions) : null,
    ]
  );

  await recordAuditEvent({
    orgId,
    actorUserId,
    action: 'scan.create',
    targetType: 'scan_job',
    targetId: rows[0].id,
    result: 'SUCCESS',
    metadata: { target: normalizedTarget, requestedClass, recommendedEngineIds: recommendedIds, selectedEngineIds: selected, recommendedCapabilities: recommendedCapabilityIds, selectedCapabilities: selectedCapabilityIds, recommendedComputeMode, selectedComputeMode: selectedComputeMode ?? null },
  });

  return { accepted: true, job: rows[0] };
}

export async function getJob(orgId, jobId) {
  const { rows } = await query('SELECT * FROM scan_jobs WHERE id = $1 AND org_id = $2 AND controlled_proof_run_id IS NULL AND deleted_at IS NULL', [jobId, orgId]);
  return rows[0] || null;
}

export async function getJobExecutionStatus(jobId) {
  const { rows } = await query('SELECT status FROM scan_jobs WHERE id = $1', [jobId]);
  return rows[0]?.status ?? null;
}

// archivedOnly:false (default) is the everyday scans list -- clean of jobs
// a user has explicitly put away. archivedOnly:true is the dedicated
// Archived view -- only the jobs someone archived, nothing else. Archiving
// never removes a row (see 0031_scan_job_archive.sql), so every job is
// visible in exactly one of these two views at any given time.
export async function listJobs(orgId, { archivedOnly = false } = {}) {
  const { rows } = await query(
    `SELECT scan_jobs.id, scan_jobs.target, scan_jobs.requested_class, scan_jobs.status, scan_jobs.attempts, scan_jobs.result,
            scan_jobs.archived_at, scan_jobs.created_at, scan_jobs.updated_at,
            (SELECT count(DISTINCT fs.finding_id)::int
               FROM normalized_observations no
               JOIN finding_sources fs ON fs.normalized_observation_id = no.id
              WHERE no.job_id = scan_jobs.id AND no.org_id = scan_jobs.org_id) AS finding_count
       FROM scan_jobs
      WHERE scan_jobs.org_id = $1 AND scan_jobs.controlled_proof_run_id IS NULL
        AND scan_jobs.deleted_at IS NULL
        AND scan_jobs.archived_at IS ${archivedOnly ? 'NOT NULL' : 'NULL'}
      ORDER BY scan_jobs.created_at DESC`,
    [orgId]
  );
  return rows;
}

// Archiving/unarchiving is available regardless of status (including
// non-terminal jobs) -- it only ever changes visibility, never execution,
// so there is no reason to gate it on the job having finished.
export async function archiveJob({ orgId, actorUserId, jobId }) {
  const { rows } = await query(
    `UPDATE scan_jobs SET archived_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND controlled_proof_run_id IS NULL AND archived_at IS NULL AND deleted_at IS NULL
      RETURNING id, status, archived_at`,
    [jobId, orgId]
  );
  if (rows.length === 0) return null;
  await recordAuditEvent({ orgId, actorUserId, action: 'scan.archive', targetType: 'scan_job', targetId: jobId, result: 'SUCCESS' });
  return rows[0];
}

export async function unarchiveJob({ orgId, actorUserId, jobId }) {
  const { rows } = await query(
    `UPDATE scan_jobs SET archived_at = NULL, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND controlled_proof_run_id IS NULL AND archived_at IS NOT NULL AND deleted_at IS NULL
      RETURNING id, status, archived_at`,
    [jobId, orgId]
  );
  if (rows.length === 0) return null;
  await recordAuditEvent({ orgId, actorUserId, action: 'scan.unarchive', targetType: 'scan_job', targetId: jobId, result: 'SUCCESS' });
  return rows[0];
}

export async function deleteJob({ orgId, actorUserId, jobId }) {
  const { rows } = await query(
    `UPDATE scan_jobs
        SET deleted_at=now(), archived_at=NULL, target='[deleted]', result=NULL, error=NULL, updated_at=now()
      WHERE id=$1 AND org_id=$2 AND controlled_proof_run_id IS NULL AND deleted_at IS NULL
        AND status IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','NO_COVERAGE')
      RETURNING id, status, deleted_at`,
    [jobId, orgId]
  );
  if (rows.length === 0) return null;
  await recordAuditEvent({
    orgId, actorUserId, action: 'scan.delete', targetType: 'scan_job', targetId: jobId,
    result: 'SUCCESS', metadata: { detailsRetained: false },
  });
  return rows[0];
}

export async function cancelJob({ orgId, actorUserId, jobId }) {
  const { rows } = await query(
    `UPDATE scan_jobs SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND org_id = $2 AND controlled_proof_run_id IS NULL
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      RETURNING id, status`,
    [jobId, orgId]
  );
  if (rows.length === 0) return null;

  await recordAuditEvent({
    orgId,
    actorUserId,
    action: 'scan.cancel',
    targetType: 'scan_job',
    targetId: jobId,
    result: 'SUCCESS',
  });
  return rows[0];
}

// Atomically claims one queued job for this worker. SKIP LOCKED means N
// concurrent workers never claim the same row or block on each other.
export async function claimNextJob(workerId, { timeoutMs } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM scan_jobs
        WHERE status = 'QUEUED'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const effectiveTimeoutMs = resolveJobTimeoutMs(rows[0], timeoutMs);
    const { rows: updated } = await client.query(
      `UPDATE scan_jobs SET
          status = 'ANALYZING',
          attempts = attempts + 1,
          locked_by = $1,
          locked_at = now(),
          timeout_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() + ($2 || ' milliseconds')::interval END,
          updated_at = now()
        WHERE id = $3
        RETURNING *`,
      [workerId, effectiveTimeoutMs, rows[0].id]
    );
    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function completeJob(jobId, result) {
  await query(
    `UPDATE scan_jobs SET status = 'COMPLETED', result = $1, locked_by = NULL, updated_at = now()
       WHERE id = $2 AND status <> 'CANCELLED'`,
    [JSON.stringify(result ?? {}), jobId]
  );
}

// A distinct terminal status from COMPLETED: the pipeline function ran
// without throwing, but analysisPlanner produced zero engines for this
// target type/class, so nothing was actually analyzed. Never call this
// with a result that ran at least one engine -- see runAnalysisPipeline's
// caller in worker.js.
export async function markNoCoverage(jobId, result) {
  await query(
    `UPDATE scan_jobs SET status = 'NO_COVERAGE', result = $1, locked_by = NULL, updated_at = now()
       WHERE id = $2 AND status <> 'CANCELLED'`,
    [JSON.stringify(result ?? {}), jobId]
  );
}

// Bounded, idempotent retry: a job gets max_attempts tries total, then it's
// FAILED for good -- never retried forever, never silently dropped.
export async function failJob(jobId, errorMessage) {
  const { rows } = await query('SELECT attempts, max_attempts FROM scan_jobs WHERE id = $1', [jobId]);
  const job = rows[0];
  if (!job) return;
  const status = await getJobExecutionStatus(jobId);
  if (status === 'CANCELLED') return;

  const nextStatus = job.attempts >= job.max_attempts ? 'FAILED' : 'QUEUED';
  await query(
    `UPDATE scan_jobs SET status = $1, error = $2, locked_by = NULL, updated_at = now() WHERE id = $3`,
    [nextStatus, errorMessage, jobId]
  );
  if (nextStatus === 'FAILED') {
    await query(
      `UPDATE controlled_proof_runs cpr SET status='FAILED', completed_at=now(),
         failure_reason='controlled_proof_worker_failed', updated_at=now()
       FROM scan_jobs sj
       WHERE sj.id=$1 AND sj.controlled_proof_run_id=cpr.id AND cpr.status='ANALYZING'`,
      [jobId]
    );
  }
}

// Sweeps jobs whose timeout_at has passed while still not in a terminal
// state -- a worker that crashed mid-job (no chance to call failJob itself)
// must not leave that job stuck in ANALYZING forever.
export async function sweepTimedOutJobs() {
  const { rows } = await query(
    `SELECT id, attempts, max_attempts FROM scan_jobs
      WHERE status NOT IN ('QUEUED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
        AND timeout_at IS NOT NULL AND timeout_at < now()`
  );

  for (const job of rows) {
    const nextStatus = job.attempts >= job.max_attempts ? 'TIMED_OUT' : 'QUEUED';
    await query(
      `UPDATE scan_jobs SET status = $1, locked_by = NULL, updated_at = now() WHERE id = $2`,
      [nextStatus, job.id]
    );
    if (nextStatus === 'TIMED_OUT') {
      await query(
        `UPDATE controlled_proof_runs cpr SET status='FAILED', completed_at=now(),
           failure_reason='controlled_proof_worker_timed_out', updated_at=now()
         FROM scan_jobs sj
         WHERE sj.id=$1 AND sj.controlled_proof_run_id=cpr.id AND cpr.status='ANALYZING'`,
        [job.id]
      );
    }
  }
  return rows.length;
}

export async function heartbeatWorker(workerId, status, currentJobId = null) {
  await query(
    `INSERT INTO job_workers (worker_id, status, current_job, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (worker_id) DO UPDATE SET status = $2, current_job = $3, last_seen_at = now()`,
    [workerId, status, currentJobId]
  );
}
