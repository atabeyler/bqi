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

// moduleId is deliberately a plain string, not a z.enum -- the real,
// current set of IMPLEMENTED module ids is fetched live from BCI's own
// GET /api/v1/engines/intrusive-modules by the caller (the route) and
// passed in as `implementedModuleIds`, then checked here AFTER structured
// generation (never baked into this file as a hardcoded, driftable copy).
// BCI's own intrusiveValidationAdapter re-validates independently again at
// execution time regardless of what passes here.
const adaptiveEntrySchema = z.object({
  moduleId: z.string(),
  rationale: z.string(),
});

// Capped at 20 to match bci/src/engines/adapters/intrusiveValidation.js's
// own engineOptions schema bound (routes/scans.js) -- a separate,
// additional budget from BASE's own automatic module selection, never a
// replacement for it.
const strategySchema = z.object({
  adaptivePlan: z.array(adaptiveEntrySchema).max(20),
  assessment: advisorNarrativeSchema,
});

export type IntrusiveAdaptivePlanEntry = z.infer<typeof adaptiveEntrySchema>;

// BCI RECOMMENDS. USER DECIDES. BCI EXECUTES. -- applied to Smart
// Intrusive: this function only ever PROPOSES additional validation
// modules layered ON TOP OF BCI's own BASE module selection (which the
// registry already picks dynamically per target/evidence -- see
// bci/src/engines/intrusive/registry.js). It never calls BCI, never
// executes anything itself, and its output is not authoritative -- an
// ADMIN's own explicit module choice (userSelectedModuleIds, threaded
// through engineOptions['intrusive-validation'] the same way this
// adaptivePlan is) is never filtered or overridden by this proposal, and
// ignoring this proposal entirely is a completely valid outcome with no
// follow-up nagging.
export async function proposeIntrusiveStrategy({
  job, engineRuns, findings, implementedModuleIds, dataClassification = 'INTERNAL', language = 'tr',
}: {
  job: { id: string; target: string; target_type?: string };
  engineRuns: EngineRun[];
  findings: Finding[];
  implementedModuleIds: string[];
  dataClassification?: string;
  language?: string;
}): Promise<AdvisorResult<IntrusiveAdaptivePlanEntry>> {
  const safeLanguage = normalizeAdvisorLanguage(language);
  // Nothing to reason about without real prior evidence -- BCI's own BASE
  // module selection already covers a first pass on its own; an AI round
  // adds value by reacting to what BASE (or a prior fuzz/nuclei pass)
  // actually found, not by guessing blind.
  if (findings.length === 0 && engineRuns.every((r) => (r.observation_count ?? 0) === 0)) {
    const completedEngines = engineRuns.filter((run) => run.status === 'COMPLETED').map((run) => run.engine_id);
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({ findings: [], anyEngineFailed: engineRuns.some((run) => run.status !== 'COMPLETED'), scopeCovered: completedEngines, narrative: advisorFallback(safeLanguage, 'NO_EVIDENCE', 'Smart Intrusive') }),
      source: 'deterministic',
    };
  }

  const evidence = {
    scanJobId: job.id,
    target: job.target,
    targetType: job.target_type,
    engineRuns: engineRuns.map((r) => ({ engineId: r.engine_id, status: r.status, observationCount: r.observation_count ?? 0, detail: r.detail ?? null })),
    findings: findings.map((f) => ({
      id: f.id, title: f.title, category: f.category, riskScore: f.risk_score, priority: f.priority, location: f.location, evidence: f.evidence,
    })),
    availableModuleIds: implementedModuleIds,
  };

  try {
    const result = await generateStructured(
      `You are the decision-support advisor that proposes an additional ADAPTIVE validation round for
BCI Smart Intrusive. BCI's dynamic BASE module selection always runs independently and your proposal
can only add to it; it can never replace or reduce BASE coverage. Use only the supplied real BCI
findings and engine-run evidence. moduleId must come from availableModuleIds, which contains only
modules BCI can actually execute. Never invent a module, endpoint or test type. Propose an adaptivePlan
only when it can validate or deepen real findings, including cross-engine reproducibility where useful;
otherwise return an empty plan. This is advisory: the ADMIN/user retains all decision and execution
authority and your proposal cannot veto their selection. Write every narrative field in
${advisorLanguageName(safeLanguage)}. ${UNTRUSTED_EVIDENCE_POLICY}
${ADVISOR_NARRATIVE_PROMPT}`,
      wrapUntrustedEvidence('BCI SMART INTRUSIVE EVIDENCE', JSON.stringify(evidence)),
      strategySchema,
      dataClassification,
      'proposeIntrusiveStrategy',
    );
    // Even a schema-valid AI response is re-checked against the real,
    // live IMPLEMENTED module list the caller supplied -- a hallucinated
    // or stale module id is dropped here, on top of BCI's own independent
    // re-validation at execution time.
    const allowed = new Set(implementedModuleIds);
    const adaptivePlan = result.adaptivePlan.filter((entry) => allowed.has(entry.moduleId));
    const failedRuns = engineRuns.filter((run) => run.status !== 'COMPLETED');
    return {
      adaptivePlan,
      ...assembleAdvisorAssessment({
        findings,
        anyEngineFailed: failedRuns.length > 0,
        scopeCovered: engineRuns.filter((run) => run.status === 'COMPLETED').map((run) => run.engine_id),
        narrative: result.assessment,
        factualLimitations: failedRuns.map((run) => `${run.engine_id}: ${run.status}`),
      }),
      source: 'ai',
    };
  } catch (err) {
    // AI is advisory and must never block Smart Intrusive -- an empty
    // adaptive plan means the caller's next scan simply runs BCI's own
    // BASE module selection alone, unchanged, exactly as if AI had never
    // been asked.
    const reason = err instanceof PolicyDenialError || err instanceof AllProvidersFailedError ? err.message : String((err as Error)?.message || err);
    const failedRuns = engineRuns.filter((run) => run.status !== 'COMPLETED');
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({
        findings,
        anyEngineFailed: failedRuns.length > 0,
        scopeCovered: engineRuns.filter((run) => run.status === 'COMPLETED').map((run) => run.engine_id),
        narrative: advisorFallback(safeLanguage, 'AI_UNAVAILABLE', 'Smart Intrusive'),
        factualLimitations: failedRuns.map((run) => `${run.engine_id}: ${run.status}`),
      }),
      source: 'deterministic',
      error: reason,
    };
  }
}
