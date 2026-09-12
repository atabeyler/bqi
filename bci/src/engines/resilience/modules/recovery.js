import { executeRound, measurePhase } from '../runRound.js';
import { buildRound } from '../recordHelpers.js';

const FAMILY = 'RECOVERY';

function waitFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); done(); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Real three-phase measurement: baseline (sequential, pre-load) -> a real
// burst load round -> recovery (sequential, post-load) -- compares the
// real recovery-phase latency/error rate back against the real baseline
// to determine whether the target actually returned to its pre-load
// behavior, and how long that took.
export const recoveryModule = {
  id: 'RECOVERY',
  family: FAMILY,
  name: 'Recovery Validation',
  description: 'Measures real baseline, applies a real burst load, then measures real post-load recovery against the baseline.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const startedAt = Date.now();
    const baseline = await measurePhase(target, { sampleCount: 3, headers, signal });
    const loadRound = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 25, totalRequests: 200, durationMs: 6000, targetRps: 50, profile: 'burst', ...requestedPlan },
    });

    const recoveryObservationMs = requestedPlan.recoveryObservationMs ?? 3000;
    await waitFor(recoveryObservationMs, signal);
    const recoveryStartedAt = Date.now();
    const recovery = await measurePhase(target, { sampleCount: 3, headers, signal });

    const baselineLatency = baseline.metrics.avgLatencyMs;
    const recoveryLatency = recovery.metrics.avgLatencyMs;
    const recovered = baselineLatency == null || recoveryLatency == null
      ? null
      : recoveryLatency <= baselineLatency * 2 && recovery.metrics.errorRate === 0;

    const status = recovered === null ? 'INCONCLUSIVE' : (recovered ? 'RECOVERED' : 'RECOVERY_FAILED');
    const endedAt = Date.now();

    return [{
      ...buildRound({
        moduleId: this.id, family: FAMILY, target, endpoints: [target],
        requestedPlan: loadRound.requestedPlan, executedPlan: loadRound.executedPlan, clamps: loadRound.clamps,
        metrics: loadRound.metrics,
        phases: { baseline: baseline.metrics, load: loadRound.metrics, recovery: recovery.metrics },
        degradation: loadRound.degradation, status, roundNumber, startedAt, endedAt,
      }),
      recoveryTimeMs: Date.now() - recoveryStartedAt + recoveryObservationMs,
      anomalyReasons: status === 'RECOVERY_FAILED' ? ['did_not_recover_after_load'] : [],
    }];
  },
};
