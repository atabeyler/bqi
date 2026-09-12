import { assertHttpTarget, curlHealthCheck } from './nativeHttp.js';
import {
  selectApplicableResilienceModules, getResilienceModule, listImplementedResilienceModules,
} from '../resilience/registry.js';

// BCI Smart Resilience -- orchestrates the Dynamic Resilience Registry
// (bci/src/engines/resilience/registry.js), the same architecture as
// Smart Intrusive: this file never hard-codes a module list, it asks the
// registry which IMPLEMENTED modules are real-time applicable to this
// target/evidence (selectApplicableResilienceModules) and runs exactly
// those. Real, genuinely concurrent/rate-paced/profile-shaped HTTP load
// generation lives in ../resilience/loadEngine.js (Node's own http/https
// client with a keep-alive Agent, not one curl process per request) --
// this file only orchestrates WHICH modules run and WHY, tagging every
// resulting round:
//
//   BASE        -- the registry's own automatic, always-run selection.
//                   Runs unconditionally; nothing here can shrink or
//                   replace it.
//   USER        -- a module the caller (an ADMIN, gated by the same
//                   scan:create + RESTRICTED-class scope approval every
//                   round already requires -- no separate/second approval
//                   gate added) explicitly named via
//                   userSelectedModuleIds, forced to run regardless of
//                   automatic applicability, never filtered by AI.
//   AI_ADAPTIVE -- a module named in an externally-proposed adaptivePlan
//                   (see server/src/services/bciResilienceAdvisor.ts),
//                   only ever ADDED on top of BASE/USER, only from BCI's
//                   own real, registered IMPLEMENTED module ids.
//
// capabilities stays exactly ['DOS'] -- Smart Resilience is a distinct
// capability from INTRUSIVE (Smart Intrusive), never merged with it, per
// spec.
export const availabilityProbeAdapter = {
  id: 'availability-probe',
  name: 'BCI Smart Resilience',
  license: 'BCI-NATIVE',
  intrusiveness: 'RESTRICTED',
  capabilities: ['DOS'],
  supportedTargetTypes: ['DOMAIN', 'SUBDOMAIN', 'URL', 'API'],
  supportedAnalysisTypes: ['DOS'],

  async healthCheck() { return curlHealthCheck(); },

  // endpoints (optional): real, already-discovered endpoints (Smart Fuzz/
  // Nuclei/naabu/Smart Intrusive) -- enables MULTI_ENDPOINT.
  // priorFindings (optional): real findings from any engine -- enables
  // CROSS_ENGINE_TARGETED_RESILIENCE.
  // requestedPlan (optional): the user's own real load parameters
  // (requestCountMode/totalRequests/concurrency/targetRps/durationMs/
  // rampUpMs/rampDownMs/requestTimeoutMs) -- validated and honored without
  // product-level clamping; every module reports requestedPlan and
  // executedPlan separately.
  // userSelectedModuleIds / adaptivePlan: see file header.
  // authHeader/customHeaders: forwarded on every request; never written
  // into any round's evidence.
  async execute({
    target, timeoutMs = 30_000, endpoints = [], priorFindings = [], requestedPlan = {},
    userSelectedModuleIds = [], adaptivePlan: externalAdaptivePlan = [], authHeader, customHeaders = [], signal,
  }) {
    const validatedTarget = assertHttpTarget(target);
    const headers = [...(authHeader ? [authHeader] : []), ...customHeaders];
    const context = { target: validatedTarget, endpoints, priorFindings, authHeader, headers, requestedPlan, roundNumber: 1, signal };

    const ran = new Set();
    const raw = [];
    let failures = 0;
    let attempts = 0;

    async function runModule(module, source, contextOverride) {
      // Deduplicated per (source, module) pair, not per module alone --
      // unlike Smart Intrusive's point-in-time checks, a resilience round
      // is explicitly allowed to run again as a genuinely new round (a
      // USER or AI_ADAPTIVE re-invocation of a module BASE already
      // covered is a real, deliberate "one more round" request, not
      // redundant duplicate work); this only prevents the exact same
      // (source, module) combination from firing twice within one call
      // (e.g. the same moduleId listed twice in one adaptivePlan).
      const key = `${source}:${module.id}`;
      if (ran.has(key)) return;
      ran.add(key);
      attempts += 1;
      try {
        const rounds = await module.run(contextOverride || context);
        for (const round of rounds) raw.push({ ...round, source });
      } catch (err) {
        if (signal?.aborted) throw err;
        failures += 1;
        raw.push({
          type: 'RESILIENCE_ROUND', module: module.id, family: module.family, target: validatedTarget, endpoints: [validatedTarget],
          requestedPlan, executedPlan: requestedPlan, clamps: [], metrics: null, phases: {}, degradation: null,
          status: 'INCONCLUSIVE', relatedFindingId: null, round: { number: 1, previous: null, next: null },
          startedAt: Date.now(), endedAt: Date.now(), anomalous: false, anomalyReasons: [], source,
          error: String(err.message || err),
        });
      }
    }

    // BASE: every module the registry says is really applicable right
    // now -- always runs, with or without AI, with or without a user
    // selection. This is the actual timeout/budget-bounded operation
    // (the selected plan governs wall-clock time, not the generic
    // single-engine timeoutMs).
    void timeoutMs; // real per-round timing is governed by loadEngine.js's own plan/duration, not this generic engine timeoutMs
    const baseModules = selectApplicableResilienceModules(context);
    for (const module of baseModules) await runModule(module, 'BASE');

    // USER: an admin's explicit choice always executes, on top of BASE.
    for (const moduleId of userSelectedModuleIds) {
      const module = getResilienceModule(moduleId);
      if (module && module.status === 'IMPLEMENTED') await runModule(module, 'USER');
    }

    // AI_ADAPTIVE: only real, registered, IMPLEMENTED module ids accepted.
    const validAdaptiveIds = new Set(listImplementedResilienceModules().map((m) => m.id));
    for (const entry of externalAdaptivePlan) {
      if (!entry?.moduleId || !validAdaptiveIds.has(entry.moduleId)) continue;
      const module = getResilienceModule(entry.moduleId);
      const adaptiveContext = entry.requestedPlan ? { ...context, requestedPlan: { ...requestedPlan, ...entry.requestedPlan } } : context;
      await runModule(module, 'AI_ADAPTIVE', adaptiveContext);
    }

    if (attempts === 0) throw new Error('no applicable resilience module for this target/evidence');
    if (failures === attempts) throw new Error('all resilience modules failed to execute');
    return { raw, moduleMeta: { attempted: attempts, base: baseModules.length, ran: [...ran] } };
  },
};
