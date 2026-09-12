import { executeRound } from '../runRound.js';

const FAMILY = 'RATE_LIMIT';

// Real burst load specifically to observe whether the target's rate
// limiting actually triggers (429/Retry-After) under genuine load --
// distinct from Smart Intrusive's RATE_LIMIT_HEADER_OBSERVATION (which is
// purely passive, two ordinary requests, never a load pattern). This
// module belongs under DOS/resilience precisely because it applies real
// load to observe the mechanism, not just its advertised headers.
export const rateLimitModule = {
  id: 'RATE_LIMIT',
  family: FAMILY,
  name: 'Rate-Limit Trigger Validation',
  description: 'A real burst load specifically to observe whether rate limiting (429/Retry-After) actually triggers under load.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 20, totalRequests: 150, durationMs: 5000, targetRps: 40, profile: 'burst', ...requestedPlan },
    });
    // Real observed rate-limiting is reported as a real, informational
    // status (RATE_LIMITED) -- confirmation the mechanism works, not
    // itself a vulnerability; the shared classifyRound() already applies
    // this from real metrics.rateLimitedCount.
    return [round];
  },
};
