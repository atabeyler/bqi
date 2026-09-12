import { executeRound } from '../runRound.js';

// Real capacity probe: a coarse ramp-up (fewer, larger time buckets) used
// to find the real approximate throughput ceiling -- reports the real
// degradation/saturation bucket analysis (loadEngine.js's
// analyzeDegradation) as the capacity signal, not an assumed number.
export const capacityModule = {
  id: 'CAPACITY',
  family: 'CAPACITY',
  name: 'Capacity Validation',
  description: 'A real coarse ramp used to find the approximate real throughput ceiling via degradation-bucket analysis.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const durationMs = requestedPlan.durationMs ?? 16_000;
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, degradationBuckets: 4, signal,
      requestedPlanOverrides: {
        concurrency: 25, totalRequests: 400, durationMs, targetRps: 60, profile: 'ramp_up',
        rampUpMs: durationMs, rampDownMs: 0, ...requestedPlan,
      },
    });
    return [round];
  },
};

// Real, fine-grained saturation detection: a denser bucket analysis
// (more, smaller time buckets over the same real ramp) specifically to
// pinpoint WHEN in the run degradation/saturation began, rather than
// CAPACITY's coarser "is there a ceiling at all" signal.
export const saturationDetectionModule = {
  id: 'SATURATION_DETECTION',
  family: 'SATURATION_DETECTION',
  name: 'Saturation Detection',
  description: 'A real fine-grained ramp with dense time-bucket analysis to pinpoint the real onset of degradation/saturation.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, headers = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const durationMs = requestedPlan.durationMs ?? 16_000;
    const round = await executeRound({
      moduleId: this.id, family: this.family, target, endpoints: null, headers, roundNumber, degradationBuckets: 8, signal,
      requestedPlanOverrides: {
        concurrency: 25, totalRequests: 400, durationMs, targetRps: 60, profile: 'ramp_up',
        rampUpMs: durationMs, rampDownMs: 0, ...requestedPlan,
      },
    });
    return [round];
  },
};
