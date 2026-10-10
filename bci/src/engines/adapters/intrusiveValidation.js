import { assertHttpTarget, curlHealthCheck } from './nativeHttp.js';
import { selectApplicableModules, getIntrusiveModule, listImplementedModules } from '../intrusive/registry.js';
import { discoverEndpoints } from './fuzzDiscovery.js';
import { resolveAuthProfile } from '../executionProfiles.js';
import { buildCoverage } from '../../pentest/verification.js';

// BCI Smart Intrusive -- orchestrates the Dynamic Intrusive Validation
// Registry (bci/src/engines/intrusive/registry.js). This file itself
// never hard-codes a validation-module list: it asks the registry which
// IMPLEMENTED modules are applicable to this target/evidence right now
// (real, per-run dynamic selection -- two different targets legitimately
// run two different module sets), runs exactly those, and tags every
// resulting record with WHERE it came from:
//
//   BASE        -- BCI's own automatic, always-run coverage. Runs
//                   unconditionally; nothing here can shrink or replace it.
//   USER        -- a module the caller (an ADMIN, per RBAC on the routes
//                   that create a scan) explicitly named via
//                   userSelectedModuleIds, validated against the live
//                   IMPLEMENTED/applicable registry before any request.
//                   Never blocked or vetoed by
//                   an AI-adaptive proposal -- "BCI ONERIR. KULLANICI
//                   KARAR VERIR." An admin's explicit choice always wins.
//   AI_ADAPTIVE -- a module named in an externally-proposed adaptivePlan
//                   (see server/src/services/bciIntrusiveAdvisor.ts),
//                   only ever ADDED on top of BASE/USER, never in place
//                   of them, and only from BCI's own real, registered
//                   IMPLEMENTED module ids -- an unrecognized id is
//                   rejected before any execution.
//
// Each module performs its own real network/HTTP execution (via
// nativeHttp.js's curlFetch) -- this orchestrator never fabricates a
// result on a module's behalf, and a module that couldn't actually run
// reports verificationStatus: 'ERROR', never a silently-passing VERIFIED.
export const intrusiveValidationAdapter = {
  id: 'intrusive-validation',
  name: 'BCI Smart Intrusive',
  license: 'BCI-NATIVE',
  intrusiveness: 'RESTRICTED',
  capabilities: ['INTRUSIVE', 'API'],
  capabilitiesByTargetType: { DOMAIN: ['INTRUSIVE'], SUBDOMAIN: ['INTRUSIVE'], URL: ['INTRUSIVE', 'API'], API: ['INTRUSIVE', 'API'] },
  supportedTargetTypes: ['DOMAIN', 'SUBDOMAIN', 'URL', 'API'],
  supportedAnalysisTypes: ['INTRUSIVE', 'API'],

  async healthCheck() { return curlHealthCheck(); },

  // priorFindings (optional): real findings from any engine, for
  // FINDING_REPRODUCIBILITY_VERIFICATION to re-check.
  // userSelectedModuleIds (optional): real registered module ids an
  // ADMIN explicitly requests; the registry still rejects a technically
  // inapplicable or not-yet-implemented module openly.
  // adaptivePlan (optional): [{moduleId, rationale}] from an AI strategy
  // proposal -- validated against real IMPLEMENTED module ids, layered on
  // top of BASE+USER, never replacing them.
  // authHeader/customHeaders (optional): forwarded on every request this
  // run makes, for authenticated validation.
  async execute({
    target, timeoutMs = 30_000, priorFindings = [], userSelectedModuleIds = [], adaptivePlan: externalAdaptivePlan = [],
    authProfileId, authHeader, customHeaders = [], signal, pentestContext, executionOrgId,
  }) {
    const throwIfCancelled = () => {
      if (!signal?.aborted) return;
      const error = new Error('Smart Intrusive execution cancelled by user');
      error.name = 'AbortError';
      throw error;
    };
    throwIfCancelled();
    const validatedTarget = assertHttpTarget(target);
    const authProfile = resolveAuthProfile(authProfileId, { orgId: executionOrgId, target: validatedTarget });
    const headers = [...authProfile.headers, ...(authHeader ? [authHeader] : []), ...customHeaders];
    const probeTimeoutMs = Math.min(timeoutMs, 7_000);
    const discovery = await discoverEndpoints(validatedTarget, { timeoutMs: probeTimeoutMs, headers, signal });
    const context = { target: validatedTarget, timeoutMs: probeTimeoutMs, headers, priorFindings, roundNumber: 1, signal, pentestContext, ...discovery };

    // Reject the complete external plan before the first network request.
    // A malformed USER/AI entry must never cause partial execution followed
    // by a misleadingly late failure.
    for (const moduleId of userSelectedModuleIds) {
      const module = getIntrusiveModule(moduleId);
      if (!module) throw new TypeError(`unknown USER intrusive module: ${moduleId}`);
      if (module.status !== 'IMPLEMENTED') throw new TypeError(`USER intrusive module is not implemented: ${moduleId}`);
      if (!module.isApplicable(context)) throw new TypeError(`USER intrusive module is not applicable: ${moduleId}`);
    }
    const validAdaptiveIds = new Set(listImplementedModules().map((module) => module.id));
    for (const entry of externalAdaptivePlan) {
      if (!entry?.moduleId || !validAdaptiveIds.has(entry.moduleId)) throw new TypeError(`invalid AI_ADAPTIVE intrusive module: ${entry?.moduleId || 'missing'}`);
      if (!getIntrusiveModule(entry.moduleId).isApplicable(context)) throw new TypeError(`AI_ADAPTIVE intrusive module is not applicable: ${entry.moduleId}`);
    }

    const ran = new Set();
    const raw = [];
    let failures = 0;
    let attempts = 0;

    async function runModule(module, source, roundNumber) {
      throwIfCancelled();
      const executionKey = `${source}:${module.id}`;
      if (ran.has(executionKey)) return; // duplicate entries within one provenance layer are de-duplicated
      ran.add(executionKey);
      attempts += 1;
      try {
        const records = await module.run({ ...context, roundNumber });
        for (const record of records) raw.push({ ...record, source });
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          const completed = [...raw, ...(err.failureObservation?.raw || []).map((r) => ({ ...r, source }))];
          err.failureObservation = { raw: completed, pentestCoverage: buildCoverage(completed) };
          throw err;
        }
        failures += 1;
        raw.push({
          type: 'INTRUSIVE_VALIDATION_RECORD', module: module.id, family: module.family, target: validatedTarget,
          endpoint: validatedTarget, testType: 'MODULE_EXECUTION', source, baseline: null, observed: null,
          evidence: { error: String(err.message || err) }, verificationStatus: 'ERROR', relatedFindingId: null,
          round: { number: roundNumber, previous: null, next: null }, anomalous: false, anomalyReasons: [],
        });
      }
    }

    // BASE: every module the registry says is really applicable right
    // now, dynamically, from real target/evidence -- always runs, with or
    // without AI, with or without a user selection.
    const baseModules = selectApplicableModules(context);
    for (const module of baseModules) await runModule(module, 'BASE', 1);

    // USER: a validated admin choice executes on top of BASE and is never
    // filtered or vetoed by AI. A BASE overlap is a distinct USER round.
    for (const moduleId of userSelectedModuleIds) {
      const module = getIntrusiveModule(moduleId);
      await runModule(module, 'USER', 2);
    }

    // AI_ADAPTIVE: only real, registered, IMPLEMENTED module ids are
    // accepted -- anything else was rejected during preflight. This is a
    // separately provenanced additive round, never a BASE/USER replacement.
    for (const entry of externalAdaptivePlan) {
      const module = getIntrusiveModule(entry.moduleId);
      await runModule(module, 'AI_ADAPTIVE', 3);
    }

    if (attempts === 0) throw new Error('no applicable intrusive validation module for this target/evidence');
    if (failures === attempts) throw new Error('all intrusive validation modules failed to execute');
    return {
      raw,
      pentestCoverage: buildCoverage(raw),
      moduleMeta: {
        attempted: attempts,
        base: baseModules.length,
        user: [...ran].filter((key) => key.startsWith('USER:')).length,
        adaptive: [...ran].filter((key) => key.startsWith('AI_ADAPTIVE:')).length,
        ran: [...ran].map((key) => key.split(':')[1]),
        authProfileId: authProfile.profileId,
        openapiSource: discovery.openapiSource,
      },
    };
  },
};
