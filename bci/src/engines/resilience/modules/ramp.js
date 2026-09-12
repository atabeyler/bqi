import { executeRound } from '../runRound.js';

// Real, gradually-increasing (ramp_up) or gradually-decreasing (ramp_down)
// request-rate profile over the plan's real rampUpMs/rampDownMs window --
// loadEngine.js's loadShapeIntensity() computes a real, different target
// rate at every scheduling tick, not a fixed rate labeled "ramp".
export const rampUpModule = {
  id: 'RAMP_UP',
  family: 'RAMP_UP',
  name: 'Ramp-Up Load Validation',
  description: 'Gradually increases request rate from zero to the target rate over the plan\'s real rampUpMs window.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const durationMs = requestedPlan.durationMs ?? 12_000;
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: {
        concurrency: 15, totalRequests: 200, durationMs, targetRps: 30, profile: 'ramp_up',
        rampUpMs: Math.floor(durationMs * 0.8), rampDownMs: 0, ...requestedPlan,
      },
    });
    return [round];
  },
};

export const rampDownModule = {
  id: 'RAMP_DOWN',
  family: 'RAMP_DOWN',
  name: 'Ramp-Down Load Validation',
  description: 'Holds the target rate then gradually decreases it to zero over the plan\'s real rampDownMs window -- checks for a clean wind-down (no error spike as load recedes).',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const durationMs = requestedPlan.durationMs ?? 12_000;
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, signal,
      requestedPlanOverrides: {
        concurrency: 15, totalRequests: 200, durationMs, targetRps: 30, profile: 'ramp_down',
        rampUpMs: 0, rampDownMs: Math.floor(durationMs * 0.8), ...requestedPlan,
      },
    });
    return [round];
  },
};
