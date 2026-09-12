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

const adaptivePlanEntrySchema = z.object({
  method: z.literal('GET'),
  url: z.string(),
  parameter: z.string(),
  location: z.enum(['query', 'header', 'body']),
  categoryId: z.string(),
  rationale: z.string(),
});

// Capped at 20 to match bci/src/engines/adapters/httpFuzz.js's
// MAX_ADAPTIVE_PROBES -- this is a SEPARATE, additional budget from BASE's
// own guaranteed per-parameter coverage (>= BASE_MIN_TESTS_PER_PARAMETER,
// fuzzCatalog.js), never a replacement for it. BCI re-enforces this same
// cap independently at execution time regardless of what this schema allows.
const strategySchema = z.object({
  adaptivePlan: z.array(adaptivePlanEntrySchema).max(20),
  assessment: advisorNarrativeSchema,
});

export type FuzzAdaptivePlanEntry = z.infer<typeof adaptivePlanEntrySchema>;

// BCI RECOMMENDS. USER DECIDES. BCI EXECUTES. -- applied to Smart Fuzz:
// this function only ever PROPOSES an ADDITIONAL round layered ON TOP OF
// BCI's own BASE fuzz plan (from real prior evidence: findings this exact
// scan already produced, plus which engines actually ran). It never calls
// BCI, never executes anything itself, and its output is not authoritative
// -- a caller passes `adaptivePlan` back to BCI's POST /scans
// (engineOptions.http-fuzz.adaptivePlan) only if/when a human decides to.
// BASE always runs in full regardless of this proposal being accepted,
// edited, or ignored entirely -- there is no follow-up nagging, no
// re-proposal loop that overrides a decision already made, and this
// function can never reduce or replace BASE's own coverage even in
// principle, since it has no way to express "run fewer BASE tests" at all.
export async function proposeFuzzStrategy({
  job, engineRuns, findings, availableCategoryIds, dataClassification = 'INTERNAL', language = 'tr',
}: {
  job: { id: string; target: string; target_type?: string };
  engineRuns: EngineRun[];
  findings: Finding[];
  availableCategoryIds: string[];
  dataClassification?: string;
  language?: string;
}): Promise<AdvisorResult<FuzzAdaptivePlanEntry>> {
  const safeLanguage = normalizeAdvisorLanguage(language);
  const fuzzRun = engineRuns.find((r) => r.engine_id === 'http-fuzz');
  const fuzzFindings = findings.filter((f) => f.evidence?.capability === 'FUZZ');

  // Nothing to reason about yet (http-fuzz never ran, or ran and found
  // nothing) -- BCI's own BASE per-parameter strategy already covers this
  // on its own; there is no real evidence here for an AI adaptive round to
  // add value to. Returning an empty adaptive plan is not a failure: BASE
  // running alone (no `adaptivePlan` supplied) is a completely valid,
  // non-error outcome, exactly as if AI had never been asked.
  if (!fuzzRun) {
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({ findings: [], anyEngineFailed: true, scopeCovered: [], narrative: advisorFallback(safeLanguage, 'NOT_RUN', 'Smart Fuzz') }),
      source: 'deterministic',
    };
  }

  const evidence = {
    scanJobId: job.id,
    target: job.target,
    targetType: job.target_type,
    fuzzEngineRun: { status: fuzzRun.status, observationCount: fuzzRun.observation_count ?? 0, detail: fuzzRun.detail ?? null },
    fuzzFindings: fuzzFindings.map((f) => ({
      id: f.id, title: f.title, riskScore: f.risk_score, priority: f.priority, location: f.location, evidence: f.evidence,
    })),
    availableCategoryIds,
  };

  try {
    const result = await generateStructured(
      `You are the decision-support advisor that proposes an additional ADAPTIVE follow-up round for
BCI Smart Fuzz. BCI's BASE fuzz scan always runs independently and your proposal can only add to it;
it can never replace or reduce BASE coverage. Use only the supplied real BCI findings and engine-run
evidence. Never invent an endpoint, parameter or URL. You may use only endpoint and parameter pairs
present in evidence.fuzzFindings. categoryId must come from availableCategoryIds. Propose a follow-up
only when real anomalies justify deeper testing with categories not already covered by BASE; otherwise
return an empty adaptivePlan. This is advisory: the user retains all decision and execution authority.
Write every narrative field in ${advisorLanguageName(safeLanguage)}. ${UNTRUSTED_EVIDENCE_POLICY}
${ADVISOR_NARRATIVE_PROMPT}`,
      wrapUntrustedEvidence('BCI SMART FUZZ EVIDENCE', JSON.stringify(evidence)),
      strategySchema,
      dataClassification,
      'proposeFuzzStrategy',
    );
    // Even a schema-valid AI response is re-checked against the real
    // findings it was given -- an entry naming an (endpoint, parameter)
    // pair that never actually appeared in the evidence is dropped here,
    // on top of BCI's own independent re-validation at execution time.
    const knownPairs = new Set(fuzzFindings.map((f) => `${(f.evidence as any)?.endpoint} ${(f.evidence as any)?.parameter}`));
    const allowedCategories = new Set(availableCategoryIds);
    const adaptivePlan = result.adaptivePlan.filter((entry) => knownPairs.has(`${entry.url} ${entry.parameter}`) && allowedCategories.has(entry.categoryId));
    return {
      adaptivePlan,
      ...assembleAdvisorAssessment({
        findings: fuzzFindings,
        anyEngineFailed: fuzzRun.status !== 'COMPLETED',
        scopeCovered: fuzzRun.status === 'COMPLETED' ? ['http-fuzz'] : [],
        narrative: result.assessment,
        factualLimitations: fuzzRun.status === 'COMPLETED' ? [] : [`http-fuzz: ${fuzzRun.status}`],
      }),
      source: 'ai',
    };
  } catch (err) {
    // AI is advisory and must never block Smart Fuzz -- an empty adaptive
    // plan means the caller's next scan simply runs BCI's own BASE
    // strategy alone, unchanged, exactly as if AI had never been asked.
    const reason = err instanceof PolicyDenialError || err instanceof AllProvidersFailedError ? err.message : String((err as Error)?.message || err);
    return {
      adaptivePlan: [],
      ...assembleAdvisorAssessment({
        findings: fuzzFindings,
        anyEngineFailed: fuzzRun.status !== 'COMPLETED',
        scopeCovered: fuzzRun.status === 'COMPLETED' ? ['http-fuzz'] : [],
        narrative: advisorFallback(safeLanguage, 'AI_UNAVAILABLE', 'Smart Fuzz'),
        factualLimitations: fuzzRun.status === 'COMPLETED' ? [] : [`http-fuzz: ${fuzzRun.status}`],
      }),
      source: 'deterministic',
      error: reason,
    };
  }
}
