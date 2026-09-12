import { clampPlan, runLoad, computeMetrics, analyzeDegradation } from './loadEngine.js';
import { buildRound, classifyRound } from './recordHelpers.js';

// Shared execution path most resilience modules delegate to -- real load
// generation (loadEngine.runLoad), real metrics (computeMetrics), and
// real saturation/degradation analysis (analyzeDegradation), wrapped into
// one provenanced RESILIENCE_ROUND. Each module supplies only what makes
// it distinct: its own requestedPlan defaults/profile and which targets
// it runs against -- the execution/measurement/classification logic is
// centralized and tested once, not re-implemented per module.
export async function executeRound({
  moduleId, family, target, endpoints, requestedPlanOverrides = {}, headers = [], roundNumber = 1, previousRound = null, relatedFindingId = null,
  degradationBuckets = 4, signal,
}) {
  const { requestedPlan, executedPlan, clamps } = clampPlan(requestedPlanOverrides);
  const startedAt = Date.now();
  const targets = endpoints && endpoints.length > 0 ? endpoints : [target];
  const { samples, actualDurationMs, stopReason } = await runLoad({ targets, plan: executedPlan, headers, signal });
  if (signal?.aborted) {
    const error = new Error('resilience execution cancelled by user');
    error.name = 'AbortError';
    throw error;
  }
  const metrics = computeMetrics(samples, actualDurationMs);
  const runtimeLimitations = [];
  const localResourceErrors = [...new Set(samples.map((sample) => sample.errorCode).filter((code) => ['EMFILE', 'ENFILE', 'ENOBUFS', 'EADDRNOTAVAIL'].includes(code)))];
  if (localResourceErrors.length > 0) {
    runtimeLimitations.push({ code: 'LOCAL_RUNTIME_RESOURCE_LIMIT', details: localResourceErrors });
  }
  if (actualDurationMs >= 1000 && metrics.actualRps < executedPlan.targetRps * 0.8) {
    runtimeLimitations.push({
      code: 'TARGET_RPS_NOT_ACHIEVED', requestedRps: executedPlan.targetRps,
      actualRps: metrics.actualRps, detail: 'Observed throughput was below the selected target; the selected plan was not rewritten.',
    });
  }
  const degradation = analyzeDegradation(samples, actualDurationMs, degradationBuckets);
  const status = classifyRound({ metrics, degradation });
  const endedAt = Date.now();

  const anomalyReasons = [];
  if (status === 'SATURATED') anomalyReasons.push('capacity_saturated');
  if (status === 'DEGRADING') anomalyReasons.push('performance_degrading_under_load');
  if (status === 'RATE_LIMITED') anomalyReasons.push('rate_limit_triggered');
  if (status === 'RECOVERY_FAILED') anomalyReasons.push('did_not_recover_after_load');

  return {
    ...buildRound({
      moduleId, family, target, endpoints: targets, requestedPlan, executedPlan, clamps,
      metrics, phases: { load: metrics }, degradation, status, roundNumber, previousRound, relatedFindingId, startedAt, endedAt,
    }),
    anomalyReasons, stopReason, runtimeLimitations,
  };
}

// A lightweight, sequential-request "phase" measurement (baseline/
// recovery) -- real requests (concurrency 1, no rate shaping), not a full
// load round. Used to establish a real pre-load baseline and a real
// post-load recovery reading to compare against it.
export async function measurePhase(target, { sampleCount = 3, headers = [], requestTimeoutMs = 5000, signal } = {}) {
  const { requestedPlan, executedPlan } = clampPlan({
    totalRequests: sampleCount, concurrency: 1, targetRps: sampleCount * 2, durationMs: 5000, requestTimeoutMs, profile: 'constant',
  });
  const { samples, actualDurationMs } = await runLoad({ targets: [target], plan: executedPlan, headers, signal });
  return { metrics: computeMetrics(samples, actualDurationMs), samples, requestedPlan, executedPlan };
}
