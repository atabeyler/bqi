// Shared round-result envelope every resilience module returns from
// run() -- the rich per-round provenance the spec requires: source,
// module, target/endpoint, requested vs. executed plan, real metrics,
// phases (baseline/load/recovery), degradation/saturation evidence,
// and round linkage.
export function buildRound({
  moduleId, family, target, endpoints, requestedPlan, executedPlan, clamps = [],
  metrics, phases = {}, degradation = null, status, roundNumber = 1, previousRound = null,
  relatedFindingId = null, startedAt, endedAt,
}) {
  return {
    type: 'RESILIENCE_ROUND',
    module: moduleId,
    family,
    target,
    endpoints,
    requestedPlan,
    executedPlan,
    clamps,
    metrics,
    phases,
    degradation,
    // A real, measurement-derived status -- never a bare PASS/FAIL. See
    // statusFor() in each module / the shared classifyRound() helper.
    status,
    relatedFindingId,
    round: { number: roundNumber, previous: previousRound, next: null },
    startedAt, endedAt,
    // anomalous/anomalyReasons mirror Smart Fuzz/Smart Intrusive's shape
    // so the normalizer can apply the same "never a finding without a
    // real reason" filter -- computed by the module from real metrics.
    anomalous: ['SATURATED', 'DEGRADING', 'RECOVERY_FAILED', 'RATE_LIMITED'].includes(status),
    anomalyReasons: [],
  };
}

// A module whose real execution failed outright (no requests could even
// be attempted -- e.g. target unreachable before any sample was taken).
export function errorRound({ moduleId, family, target, endpoints, requestedPlan, error, roundNumber = 1 }) {
  const now = Date.now();
  return {
    ...buildRound({
      moduleId, family, target, endpoints, requestedPlan, executedPlan: requestedPlan, clamps: [],
      metrics: null, phases: {}, degradation: null, status: 'INCONCLUSIVE', roundNumber, startedAt: now, endedAt: now,
    }),
    error: String(error?.message || error),
  };
}

// Real, measurement-derived classification -- never a bare PASS/FAIL.
export function classifyRound({ metrics, degradation, recovery }) {
  if (!metrics || metrics.attempted === 0) return 'INCONCLUSIVE';
  if (metrics.rateLimitedCount > 0 && metrics.rateLimitedCount >= metrics.completed * 0.2) return 'RATE_LIMITED';
  if (recovery && recovery.recovered === false) return 'RECOVERY_FAILED';
  if (degradation?.signal === 'SATURATED') return 'SATURATED';
  if (degradation?.signal === 'DEGRADING') return 'DEGRADING';
  if (recovery && recovery.recovered === true) return 'RECOVERED';
  if (metrics.errorRate < 0.05 && metrics.timeoutRate < 0.05) return 'STABLE';
  return 'DEGRADING';
}
