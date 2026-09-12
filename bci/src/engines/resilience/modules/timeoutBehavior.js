import { executeRound } from '../runRound.js';

const FAMILY = 'TIMEOUT_BEHAVIOR';

// Real load applied with a deliberately tight real request timeout --
// measures the real timeout rate this specific target/network path
// produces at a short timeout, distinct from the default generous
// timeout every other module uses.
export const timeoutBehaviorModule = {
  id: 'TIMEOUT_BEHAVIOR',
  family: FAMILY,
  name: 'Timeout Behavior Validation',
  description: 'Applies real load with a deliberately tight request timeout and measures the real resulting timeout rate.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 15, totalRequests: 100, durationMs: 6000, targetRps: 25, requestTimeoutMs: 800, profile: 'constant', ...requestedPlan },
    });
    return [round];
  },
};
