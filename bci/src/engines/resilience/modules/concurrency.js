import { executeRound } from '../runRound.js';

const FAMILY = 'CONCURRENCY';

// Real concurrent-connection load: a real, user/BCI-scoped concurrency
// level held for a short real duration -- exercises actual simultaneous
// connection handling, not sequential requests. Uses the caller's own
// requestedPlan (Wizard/API) when supplied.
export const concurrencyModule = {
  id: 'CONCURRENCY',
  family: FAMILY,
  name: 'Concurrency Validation',
  description: 'Holds a real concurrent connection level for a short duration and measures real success/latency behavior.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 10, totalRequests: 50, durationMs: 8000, targetRps: 30, profile: 'constant', ...requestedPlan },
    });
    return [round];
  },
};
