import { executeRound } from '../runRound.js';

const FAMILY = 'SUSTAINED_LOAD';

// Real constant-rate load held for the plan's real full duration -- the
// straightforward "hold N RPS for T seconds" profile every other shaped
// profile (ramp/spike/burst) is a variation of.
export const sustainedLoadModule = {
  id: 'SUSTAINED_LOAD',
  family: FAMILY,
  name: 'Sustained Load Validation',
  description: 'Holds a real constant request rate for the full plan duration.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 20, totalRequests: 500, durationMs: 15_000, targetRps: 40, profile: 'constant', ...requestedPlan },
    });
    return [round];
  },
};
