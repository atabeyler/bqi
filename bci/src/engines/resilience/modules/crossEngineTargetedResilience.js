import { executeRound } from '../runRound.js';

const FAMILY = 'CROSS_ENGINE_TARGETED_RESILIENCE';

function extractEndpoints(priorFindings) {
  return [...new Set(
    priorFindings.map((f) => f.evidence?.endpoint || f.location).filter((e) => typeof e === 'string' && /^https?:\/\//.test(e))
  )];
}

// Real load targeted specifically at the real endpoints named in real
// prior findings from OTHER engines (Smart Fuzz, Nuclei, Smart Intrusive)
// -- e.g. checking whether an endpoint already flagged for a reflected
// payload or a CORS misconfiguration also holds up under real concurrent
// load, rather than fuzzing generically. Only applicable when real
// findings with a real, extractable endpoint were actually supplied.
export const crossEngineTargetedResilienceModule = {
  id: 'CROSS_ENGINE_TARGETED_RESILIENCE',
  family: FAMILY,
  name: 'Cross-Engine Targeted Resilience Validation',
  description: 'Applies real load specifically to the real endpoints named in prior findings from other BCI engines.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: (context) => Array.isArray(context.priorFindings) && extractEndpoints(context.priorFindings).length > 0,

  async run({ target, headers = [], priorFindings = [], roundNumber = 1, requestedPlan = {}, signal }) {
    const endpoints = extractEndpoints(priorFindings);
    const round = await executeRound({
      moduleId: this.id, family: FAMILY, target, endpoints, headers, roundNumber, signal,
      requestedPlanOverrides: { concurrency: 15, totalRequests: 150, durationMs: 8000, targetRps: 25, profile: 'constant', ...requestedPlan },
      relatedFindingId: priorFindings[0]?.id ?? null,
    });
    return [round];
  },
};
