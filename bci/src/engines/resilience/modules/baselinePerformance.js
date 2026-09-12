import { measurePhase } from '../runRound.js';
import { buildRound } from '../recordHelpers.js';

const FAMILY = 'BASELINE_PERFORMANCE';

// Real, sequential (no concurrency, no rate shaping) baseline latency/
// availability measurement -- the same real request pattern the original
// 3-sample availability probe used, now the explicit BASELINE phase every
// other module can compare its own load-phase metrics against.
export const baselinePerformanceModule = {
  id: 'BASELINE_PERFORMANCE',
  family: FAMILY,
  name: 'Baseline Performance Measurement',
  description: 'Real, sequential baseline latency/availability sample -- no concurrency, no load -- every other module compares against this.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, signal }) {
    const { metrics, requestedPlan, executedPlan } = await measurePhase(target, { sampleCount: 3, headers, signal });
    const status = metrics.attempted === 0 ? 'INCONCLUSIVE' : (metrics.errorRate === 0 && metrics.timeoutRate === 0 ? 'STABLE' : 'DEGRADING');
    return [{
      ...buildRound({
        moduleId: this.id, family: FAMILY, target, endpoints: [target], requestedPlan, executedPlan, clamps: [],
        metrics, phases: { baseline: metrics }, degradation: null, status, roundNumber, startedAt: Date.now(), endedAt: Date.now(),
      }),
      anomalyReasons: status === 'DEGRADING' ? ['baseline_unstable'] : [],
    }];
  },
};
