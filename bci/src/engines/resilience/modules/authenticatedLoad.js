import { executeRound } from '../runRound.js';

const FAMILY = 'AUTHENTICATED_LOAD';

// Real load with the caller-supplied real auth header forwarded on every
// request -- only applicable when one was actually provided; never
// invents or reuses credential material, and (like Smart Fuzz/Smart
// Intrusive) never writes the credential value itself into any
// finding/evidence -- only that authenticated load was exercised.
export const authenticatedLoadModule = {
  id: 'AUTHENTICATED_LOAD',
  family: FAMILY,
  name: 'Authenticated Load Validation',
  description: 'Real load with a caller-supplied auth header applied -- exercises authenticated-session capacity, not just anonymous endpoints.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: (context) => !!context.authHeader,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 15, totalRequests: 150, durationMs: 8000, targetRps: 25, profile: 'constant', ...requestedPlan },
    });
    // The auth header itself is only ever in `headers` (used to actually
    // send the requests) -- never copied into the round's own evidence.
    return [round];
  },
};
