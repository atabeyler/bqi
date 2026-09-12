import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { planEngines } from './analysisPlanner.js';
import { prepareExecutionTarget, runPlannedEngine } from './scanExecution.js';
import { storeRawObservation, normalizeStoredObservation } from './normalization.js';
import { getOrEnrichVulnerability } from './intelligence.js';
import { correlateJobObservations } from './correlation.js';
import { syncSecurityGraph } from './securityGraph.js';
import { ingestPostureEnvelope } from './postureIntelligence.js';
import { mapEvidenceBackedTechniques } from './attackMapping.js';

const MAX_CVE_ENRICHMENTS_PER_JOB = 5; // NVD's unauthenticated rate limit is strict; this is a per-job ceiling, not a bulk sync.

async function recordEngineRun(jobId, engineId, status, detail, observationCount = 0) {
  await query(
    `INSERT INTO scan_job_engine_runs (job_id, engine_id, status, detail, observation_count, finished_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 = 'RUNNING' THEN NULL ELSE now() END)
     ON CONFLICT (job_id, engine_id) DO UPDATE SET
       status = EXCLUDED.status,
       detail = EXCLUDED.detail,
       observation_count = EXCLUDED.observation_count,
       finished_at = EXCLUDED.finished_at`,
    [jobId, engineId, status, detail ?? null, observationCount]
  );
}

// The real pipeline the worker runs per job (spec section 3.1):
//   AUTHORIZED TARGET -> ANALYSIS PLANNER -> ENGINE SELECTION ->
//   ISOLATED ENGINE EXECUTION -> RAW OBSERVATIONS -> NORMALIZATION ->
//   INTELLIGENCE ENRICHMENT -> CORRELATION (which itself does
//   verification + confidence + risk, M7/M9) -> SECURITY GRAPH
// Reporting is on-demand (M12), not generated automatically per job.
export async function runAnalysisPipeline(job, { signal } = {}) {
  const recommendedPlan = planEngines(job.target_type, job.requested_class, job.selected_capability_ids);
  // job.selected_engine_ids (set at enqueueScan time, jobQueue.js) is
  // always a validated subset of recommendedPlan's engine ids -- never an
  // arbitrary list -- so this only ever narrows what runs, it can't smuggle
  // in an incompatible/unhealthy engine the planner didn't recommend. A
  // null/empty selection (every job created before this existed, and the
  // default when a caller never specifies one) runs the full recommended
  // plan, identical to the pre-selection behavior.
  const plan = job.selected_engine_ids?.length
    ? recommendedPlan.filter((p) => job.selected_engine_ids.includes(p.engineId))
    : recommendedPlan;

  if (plan.length === 0) {
    logger.warn({ jobId: job.id, targetType: job.target_type }, 'No engine coverage for this target type');
    return {
      recommendedCapabilities: job.recommended_capability_ids ?? [],
      selectedCapabilities: job.selected_capability_ids ?? [],
      actualExecutedCapabilities: [],
      recommendedEngines: job.recommended_engine_ids ?? [],
      selectedEngines: job.selected_engine_ids ?? [],
      enginesRun: [], enginesSkipped: [], findingIds: [],
      note: `no engine coverage for target type ${job.target_type}`,
    };
  }

  const { executionTarget, cleanup } = await prepareExecutionTarget(job.target_type, job.target);
  const ran = [];
  const skipped = [];
  const newCveIds = new Set();

  try {
    for (const enginePlan of plan) {
      if (signal?.aborted) {
        const error = new Error('scan cancelled by user');
        error.name = 'AbortError';
        throw error;
      }
      try {
        await recordEngineRun(job.id, enginePlan.engineId, 'RUNNING', JSON.stringify({ phase: 'STARTING' }), 0);
        const raw = await runPlannedEngine(
          enginePlan,
          executionTarget,
          job.engine_options?.[enginePlan.engineId],
          signal,
          async (progress) => recordEngineRun(
            job.id,
            enginePlan.engineId,
            'RUNNING',
            JSON.stringify(progress),
            progress?.completed ?? 0
          ).catch((progressError) => logger.warn({ progressError, jobId: job.id, engineId: enginePlan.engineId }, 'Engine progress could not be persisted'))
        );
        if (enginePlan.engineId === 'bci-posture-intelligence') {
          await ingestPostureEnvelope({
            orgId: job.org_id,
            jobId: job.id,
            target: job.target,
            targetType: job.target_type,
            envelope: raw,
          });
        }
        const rawId = await storeRawObservation({
          orgId: job.org_id,
          jobId: job.id,
          engineId: enginePlan.engineId,
          target: job.target,
          payload: raw,
        });
        const normalizedIds = await normalizeStoredObservation(rawId);

        const { rows: cveRows } = await query(
          `SELECT DISTINCT unnest(cve_ids) AS cve_id FROM normalized_observations WHERE id = ANY($1)`,
          [normalizedIds]
        );
        cveRows.forEach((r) => newCveIds.add(r.cve_id));

        await recordEngineRun(job.id, enginePlan.engineId, 'COMPLETED', null, normalizedIds.length);
        ran.push(enginePlan.engineId);
      } catch (err) {
        if (err?.failureObservation && typeof err.failureObservation === 'object') {
          await storeRawObservation({
            orgId: job.org_id,
            jobId: job.id,
            engineId: enginePlan.engineId,
            target: job.target,
            payload: err.failureObservation,
          }).catch((evidenceError) => logger.warn({ evidenceError, jobId: job.id, engineId: enginePlan.engineId }, 'Failed engine evidence could not be persisted'));
        }
        if (err?.name === 'AbortError' || signal?.aborted) {
          await recordEngineRun(job.id, enginePlan.engineId, 'CANCELLED', String(err.message || err), err?.completedObservations ?? 0);
          throw err;
        }
        const status = err?.skipped ? 'SKIPPED' : 'FAILED';
        await recordEngineRun(job.id, enginePlan.engineId, status, String(err.message || err));
        skipped.push({ engineId: enginePlan.engineId, reason: String(err.message || err) });
        logger.warn({ err, jobId: job.id, engineId: enginePlan.engineId }, 'Engine execution did not complete');
      }
    }
  } finally {
    await cleanup();
  }

  // Intelligence enrichment BEFORE correlation, so Correlation's risk
  // computation (M9) sees fresh CVSS/EPSS/KEV data for anything genuinely
  // new, not whatever (possibly nothing) was cached from a prior job.
  for (const cveId of [...newCveIds].slice(0, MAX_CVE_ENRICHMENTS_PER_JOB)) {
    await getOrEnrichVulnerability(cveId).catch((err) => logger.warn({ err, cveId }, 'CVE enrichment failed'));
  }

  const findingIds = await correlateJobObservations(job.org_id, job.id);
  await mapEvidenceBackedTechniques(job.org_id, findingIds);
  await syncSecurityGraph(job.org_id).catch((err) => logger.warn({ err, jobId: job.id }, 'Security graph sync failed'));

  const actualExecutedCapabilities = [...new Set(plan
    .filter((enginePlan) => ran.includes(enginePlan.engineId))
    .flatMap((enginePlan) => enginePlan.capabilities))];
  return {
    recommendedCapabilities: job.recommended_capability_ids ?? [],
    selectedCapabilities: job.selected_capability_ids ?? [],
    actualExecutedCapabilities,
    recommendedEngines: job.recommended_engine_ids ?? recommendedPlan.map((enginePlan) => enginePlan.engineId),
    selectedEngines: job.selected_engine_ids ?? recommendedPlan.map((enginePlan) => enginePlan.engineId),
    enginesRun: ran,
    enginesSkipped: skipped,
    findingIds,
  };
}
