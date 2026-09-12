import { executeRound } from '../runRound.js';

// Real spike: low baseline rate with one real short high-intensity window
// in the middle of the run (loadShapeIntensity's 'spike' shape) -- checks
// whether a sudden real jump in rate causes real errors/latency spikes
// that a slower ramp would not have exposed.
export const spikeModule = {
  id: 'SPIKE',
  family: 'SPIKE',
  name: 'Spike Load Validation',
  description: 'A real low baseline rate with one short, real high-intensity spike window in the middle of the run.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 30, totalRequests: 300, durationMs: 10_000, targetRps: 50, profile: 'spike', ...requestedPlan },
    });
    return [round];
  },
};

// Real burst: full intensity for a short real window at the start, then
// stops -- checks real behavior under a sudden short-lived surge (e.g. a
// flash-crowd/thundering-herd pattern) distinct from a spike (which
// returns to a nonzero baseline afterward).
export const burstModule = {
  id: 'BURST',
  family: 'BURST',
  name: 'Burst Load Validation',
  description: 'Real full-intensity request burst for a short window at the start of the run, then stops.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 30, totalRequests: 200, durationMs: 6000, targetRps: 60, profile: 'burst', ...requestedPlan },
    });
    return [round];
  },
};
