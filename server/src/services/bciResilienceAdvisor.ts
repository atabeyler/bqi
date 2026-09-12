import { z } from 'zod';
import { generateStructured, AllProvidersFailedError, PolicyDenialError } from './aiGenerate.js';
import { UNTRUSTED_EVIDENCE_POLICY, wrapUntrustedEvidence } from './aiPrompts.js';
import {
  ADVISOR_NARRATIVE_PROMPT,
  advisorFallback,
  advisorLanguageName,
  advisorNarrativeSchema,
  assembleAdvisorAssessment,
  normalizeAdvisorLanguage,
  type AdvisorResult,
} from './bciAdvisorAssessment.js';

type EngineRun = { engine_id: string; status: string; observation_count?: number | null; detail?: string | null };
type Finding = {
  id: string; title?: string; category?: string; risk_score?: number | null; priority?: string | null;
  location?: string | null; evidence?: Record<string, unknown> | null;
};

// moduleId is a plain string, not a z.enum -- the real, current set of
// IMPLEMENTED module ids is fetched live from BCI's own
// GET /api/v1/engines/resilience-modules by the caller (the route) and
// passed in as `implementedModuleIds` (never a hardcoded, driftable
// copy). BCI's own availabilityProbeAdapter re-validates independently
// again at execution time regardless of what passes here.
const adaptiveEntrySchema = z.object({
  moduleId: z.string(),
  // The AI may propose adjusted LOAD PARAMETERS for its own suggested
  // round (e.g. "run CAPACITY again with a longer rampUpMs"). This remains
  // advisory and never edits or replaces an ADMIN's requested plan.
  requestedPlan: z.object({
    requestCountMode: z.enum(['100', '500', '1000', '5000', '10000', 'CUSTOM', 'UNLIMITED']),
    totalRequests: z.number().int().positive().nullable(),
    concurrency: z.number().int().positive(),
    targetRps: z.number().positive(),
    durationMs: z.number().int().positive().nullable(),
  }).partial().optional(),
  rationale: z.string(),
});

const strategySchema = z.object({
  adaptivePlan: z.array(adaptiveEntrySchema).max(10),
  assessment: advisorNarrativeSchema,
});

export type ResilienceAdaptivePlanEntry = z.infer<typeof adaptiveEntrySchema>;

// BCI RECOMMENDS. USER DECIDES. BCI EXECUTES. -- applied to Smart
// Resilience: this function only ever PROPOSES additional resilience
// rounds layered ON TOP OF BCI's own BASE module selection and the
// user's own requestedPlan. It never calls BCI, never executes any real
// load itself (execution always happens in
// bci/src/engines/resilience/loadEngine.js), and its output is not
// authoritative -- an ADMIN's own explicit module choice
// (userSelectedModuleIds) or their own requestedPlan is never filtered,
// reduced, or overridden by this proposal, and ignoring it entirely is a
// completely valid outcome with no follow-up nagging.
export async function proposeResilienceStrategy({
  job, engineRuns, findings, implementedModuleIds, dataClassification = 'INTERNAL', language = 'tr',
}: {
  job: { id: string; target: string; target_type?: string };
  engineRuns: EngineRun[];
  findings: Finding[];
  implementedModuleIds: string[];
  dataClassification?: string;
  language?: string;
}): Promise<AdvisorResult<ResilienceAdaptivePlanEntry>> {
  const safeLanguage = normalizeAdvisorLanguage(language);
  const resilienceRun = engineRuns.find((r) => r.engine_id === 'availability-probe');
  const resilienceFindings = findings.filter((f) => f.evidence?.capability === 'DOS');

  // Nothing to reason about without a real prior BASE round -- BCI's own
  // dynamic module selection already covers a first pass on its own.
  if (!resilienceRun) {
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({ findings: [], anyEngineFailed: true, scopeCovered: [], narrative: advisorFallback(safeLanguage, 'NOT_RUN', 'Smart Resilience') }),
      source: 'deterministic',
    };
  }

  const evidence = {
    scanJobId: job.id,
    target: job.target,
    targetType: job.target_type,
    resilienceEngineRun: { status: resilienceRun.status, observationCount: resilienceRun.observation_count ?? 0, detail: resilienceRun.detail ?? null },
    resilienceFindings: resilienceFindings.map((f) => ({
      id: f.id, title: f.title, riskScore: f.risk_score, priority: f.priority, location: f.location, evidence: f.evidence,
    })),
    availableModuleIds: implementedModuleIds,
  };

  try {
    const result = await generateStructured(
      `You are the decision-support advisor that proposes an additional ADAPTIVE load round for BCI
Smart Resilience. BCI's BASE module selection and the user's requestedPlan always remain intact; your
proposal can only add to them and can never replace, reduce or silently clamp the user's plan. Use only
the supplied real BCI metrics and findings, including latency, throughput, error/timeout rate,
saturation/degradation signals and recovery state. moduleId must come from availableModuleIds, which
contains only modules BCI can actually execute. Never invent a module or test type. You may recommend
requestedPlan parameters only for a separate follow-up round that the user can review and approve; this
function never generates load itself. Propose a round only when real degradation, saturation or rate-limit
evidence justifies validation; otherwise return an empty adaptivePlan. The ADMIN/user retains all decision
and execution authority. Write every narrative field in ${advisorLanguageName(safeLanguage)}.
${UNTRUSTED_EVIDENCE_POLICY}
${ADVISOR_NARRATIVE_PROMPT}`,
      wrapUntrustedEvidence('BCI SMART RESILIENCE EVIDENCE', JSON.stringify(evidence)),
      strategySchema,
      dataClassification,
      'proposeResilienceStrategy',
    );
    const allowed = new Set(implementedModuleIds);
    const adaptivePlan = result.adaptivePlan.filter((entry) => allowed.has(entry.moduleId));
    return {
      adaptivePlan,
      ...assembleAdvisorAssessment({
        findings: resilienceFindings,
        anyEngineFailed: resilienceRun.status !== 'COMPLETED',
        scopeCovered: resilienceRun.status === 'COMPLETED' ? ['availability-probe'] : [],
        narrative: result.assessment,
        factualLimitations: resilienceRun.status === 'COMPLETED' ? [] : [`availability-probe: ${resilienceRun.status}`],
      }),
      source: 'ai',
    };
  } catch (err) {
    const reason = err instanceof PolicyDenialError || err instanceof AllProvidersFailedError ? err.message : String((err as Error)?.message || err);
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({
        findings: resilienceFindings,
        anyEngineFailed: resilienceRun.status !== 'COMPLETED',
        scopeCovered: resilienceRun.status === 'COMPLETED' ? ['availability-probe'] : [],
        narrative: advisorFallback(safeLanguage, 'AI_UNAVAILABLE', 'Smart Resilience'),
        factualLimitations: resilienceRun.status === 'COMPLETED' ? [] : [`availability-probe: ${resilienceRun.status}`],
      }),
      source: 'deterministic',
      error: reason,
    };
  }
}
