import { executeRound } from '../runRound.js';

const FAMILY = 'MULTI_ENDPOINT';

// Real load spread round-robin across multiple real, already-discovered
// endpoints (e.g. from Smart Fuzz/Nuclei/Smart Intrusive's own real
// discovery) instead of one URL -- only applicable when the caller
// actually supplied 2+ real endpoints; never invents additional targets.
export const multiEndpointModule = {
  id: 'MULTI_ENDPOINT',
  family: FAMILY,
  name: 'Multi-Endpoint Load Validation',
  description: 'Spreads a real load round across multiple real, already-discovered endpoints instead of a single URL.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: (context) => Array.isArray(context.endpoints) && context.endpoints.length >= 2,

  async run({ target, endpoints, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 20, totalRequests: 200, durationMs: 10_000, targetRps: 30, profile: 'constant', ...requestedPlan },
    });
    return [round];
  },
};
