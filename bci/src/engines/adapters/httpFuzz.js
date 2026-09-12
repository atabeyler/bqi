import { assertHttpTarget, curlFetch, curlHealthCheck } from './nativeHttp.js';
import { discoverEndpoints } from './fuzzDiscovery.js';
import { FUZZ_CATEGORY_IDS, defaultCategoriesFor, getCategory } from './fuzzCatalog.js';
import { FUZZ_BASE_PROFILES, resolveAuthProfile, resolveFuzzBaseScope } from '../executionProfiles.js';

// BCI Smart Fuzz. Real endpoint/parameter discovery (fuzzDiscovery.js: same-
// origin HTML links/forms, robots.txt/sitemap, OpenAPI/Swagger when
// present) drives a DYNAMIC probe set built per discovered parameter --
// this is no longer one fixed list of 8 cases run identically regardless
// of target. Response behavior (status, body size, latency, and reflected-
// payload detection) is compared against a real per-endpoint baseline
// request, not judged on status alone. Stays SAFE_ACTIVE: only GET
// endpoints are actually probed; any discovered mutating (POST/PUT/PATCH/
// DELETE) endpoint is reported as discovered-but-not-executed, honestly,
// rather than either faking a result or silently dropping it.
//
// BASE FUZZ + AI ADAPTIVE FUZZ (two distinct, separately provenanced
// layers -- never merged into one undifferentiated pool):
//   - BASE (buildBasePlan): BCI's own, always-real, always-run coverage.
//     Every executable (endpoint, parameter) pair gets its full
//     defaultCategoriesFor(type) set -- never fewer than
//     BASE_MIN_TESTS_PER_PARAMETER (fuzzCatalog.js enforces >=8 for every
//     real param type; see engines.activeScan.test.js's regression check).
//     Runs unconditionally, with or without AI, with or without an
//     `adaptivePlan` -- nothing in this file can shrink or replace it.
//   - AI ADAPTIVE (sanitizeAdaptivePlan): an OPTIONAL, separately-budgeted
//     set of additional probes an external caller (BQI's AI
//     strategy advisor, server-side -- see server/src/services/
//     bciFuzzAdvisor.ts) may propose to layer ON TOP of BASE, e.g. to
//     deepen a parameter with a category BASE's type inference didn't
//     already cover. Every entry must still name a real discovered
//     executable (method,url,parameter) triple AND a real
//     FUZZ_CATEGORY_IDS category, or it's dropped -- an external caller can
//     never inject an unreviewed payload, and can never touch BASE's own
//     plan. Omitting `adaptivePlan` entirely runs BASE alone, unchanged
//     from before AI involvement existed -- AI is advisory and additive
//     only, never required for this engine's core coverage to work.
export const MAX_BASE_PARAMETERS = 15; // backwards-compatible STANDARD profile value; not a product maximum
export const MAX_ADAPTIVE_PROBES = 20; // a separate, independent budget -- can never eat into or displace BASE's own requests
const SIZE_DELTA_RATIO = 3; // body more than 3x baseline (or less than 1/3) is a real behavioral difference
const TIME_DELTA_MS = 2000; // latency more than 2s over baseline is worth flagging (never itself exploited -- observational)
const MAX_PROBE_CONCURRENCY = 2; // bounded per scan/host: improves completion without turning fuzz into a load test

// A synthetic, clearly-BCI-namespaced query parameter used only when an
// executable endpoint has no real discovered parameter at all -- the same
// approach the original 8-case engine always used (it only ever had this
// one synthetic parameter). Preserves "still exercises a bare endpoint
// with no query string" behavior while every endpoint that DOES have real
// parameters now gets fuzzed on those instead.
const SYNTHETIC_PARAM = { name: 'bci_probe', location: 'query', type: 'string' };

export function classifyHttpFuzzFailure(error) {
  const message = String(error?.message || error || '');
  if (/timed out|timeout|operation timed out|etimedout/i.test(message)) return 'TIMEOUT';
  if (/certificate|ssl|tls|unable to get local issuer|self signed/i.test(message)) return 'TLS_VALIDATION';
  if (/could not resolve|enotfound|eai_again|name resolution/i.test(message)) return 'DNS_RESOLUTION';
  if (/connection refused|could not connect|econnrefused|connection reset|econnreset/i.test(message)) return 'CONNECTION';
  return 'HTTP_TRANSPORT';
}

function safeFailureDetail(error) {
  return String(error?.message || error || 'HTTP probe failed')
    .replace(/(authorization|cookie|set-cookie|x-api-key)\s*:\s*\S+/gi, '$1: [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 500);
}

export function summarizeHttpFuzzFailures(probes) {
  const failed = probes.filter((probe) => probe?.type === 'HTTP_FUZZ_PROBE' && probe.status == null && probe.errorCode);
  const counts = failed.reduce((out, probe) => {
    out[probe.errorCode] = (out[probe.errorCode] || 0) + 1;
    return out;
  }, {});
  return {
    total: failed.length,
    counts,
    samples: failed.slice(0, 5).map((probe) => ({
      endpoint: probe.endpoint,
      category: probe.category,
      errorCode: probe.errorCode,
      detail: probe.error,
    })),
  };
}

function discoveredPairs(endpoints) {
  const pairs = [];
  for (const endpoint of endpoints) {
    if (!endpoint.executable) continue;
    const params = endpoint.params.length > 0 ? endpoint.params : [SYNTHETIC_PARAM];
    for (const param of params) pairs.push({ endpoint, param });
  }
  return pairs;
}

// BCI's own guaranteed coverage. Caps how many distinct PARAMETERS get
// base-fuzzed (a real, bounded fairness limit across a large discovered
// surface), but never caps how many categories run for a parameter that
// IS selected -- each one always gets its full, real
// defaultCategoriesFor(type) set (>= BASE_MIN_TESTS_PER_PARAMETER).
export function buildBasePlan(endpoints, scope = {}) {
  // Callers may pass either the raw Wizard/API selection or an already
  // resolved scope. Accepting both prevents a validated CUSTOM value from
  // being discarded when the adapter hands the plan builder its scope.
  const { maxParameters } = Object.hasOwn(scope, 'maxParameters')
    ? scope
    : resolveFuzzBaseScope(scope.baseProfile, scope.customMaxParameters);
  const plan = [];
  const pairs = discoveredPairs(endpoints);
  const selectedPairs = maxParameters == null ? pairs : pairs.slice(0, maxParameters);
  for (const { endpoint, param } of selectedPairs) {
    const categories = defaultCategoriesFor(param.type);
    for (const categoryId of categories) {
      plan.push({ method: endpoint.method, url: endpoint.url, parameter: param.name, location: param.location, categoryId, source: 'BASE' });
    }
  }
  return plan;
}

// Never trusts an externally-supplied adaptive plan blindly: every entry
// must name a real discovered executable (method,url,parameter) triple AND
// a real category id from BCI's own catalog, or it's dropped. Capped
// independently of BASE's own budget (MAX_ADAPTIVE_PROBES) -- a large
// adaptive proposal can never crowd out BASE coverage, because BASE is
// already built and fixed before this ever runs.
export function sanitizeAdaptivePlan(rawPlan, endpoints) {
  const validPairs = new Set(discoveredPairs(endpoints).map(({ endpoint, param }) => `${endpoint.method} ${endpoint.url} ${param.location} ${param.name}`));
  const sanitized = rawPlan.filter((entry) => (
    entry && FUZZ_CATEGORY_IDS.includes(entry.categoryId)
    && validPairs.has(`${entry.method} ${entry.url} ${entry.location} ${entry.parameter}`)
  ));
  return sanitized.slice(0, MAX_ADAPTIVE_PROBES).map((entry) => ({ ...entry, source: 'AI_ADAPTIVE' }));
}

export function sanitizeUserPlan(rawPlan, endpoints) {
  const validPairs = new Set(discoveredPairs(endpoints).map(({ endpoint, param }) => `${endpoint.method} ${endpoint.url} ${param.location} ${param.name}`));
  const sanitized = rawPlan.filter((entry) => (
    entry && FUZZ_CATEGORY_IDS.includes(entry.categoryId)
    && validPairs.has(`${entry.method} ${entry.url} ${entry.location} ${entry.parameter}`)
  ));
  if (sanitized.length !== rawPlan.length) throw new TypeError('invalid USER fuzz plan: unknown category or discovered endpoint/parameter');
  return sanitized.map((entry) => ({ ...entry, source: 'USER' }));
}

function applyProbe(baseUrl, location, parameter, value, headers) {
  const url = new URL(baseUrl);
  const outHeaders = [...headers];
  if (location === 'query') {
    url.searchParams.set(parameter, value);
  } else if (location === 'header') {
    outHeaders.push(`${parameter}: ${value}`);
  } else {
    // 'body' parameters are only ever reached via GET-mirrored form
    // fields today (see fuzzDiscovery.js) -- represented as a query
    // fallback so a form's GET-equivalent surface still gets exercised
    // without BCI inventing a POST body against a live target.
    url.searchParams.set(parameter, value);
  }
  return { url: url.toString(), headers: outHeaders };
}

export const httpFuzzAdapter = {
  id: 'http-fuzz',
  name: 'BCI Smart Fuzz',
  license: 'BCI-NATIVE',
  intrusiveness: 'SAFE_ACTIVE',
  capabilities: ['FUZZ'],
  supportedTargetTypes: ['DOMAIN', 'SUBDOMAIN', 'URL', 'API'],
  supportedAnalysisTypes: ['FUZZ'],
  executionOptions: { baseProfiles: [...Object.keys(FUZZ_BASE_PROFILES), 'CUSTOM'], standardMaxParameters: MAX_BASE_PARAMETERS, aiAdaptiveMaxProbes: MAX_ADAPTIVE_PROBES },

  async healthCheck() {
    return curlHealthCheck();
  },

  // authHeader (optional string, e.g. "Authorization: Bearer <token>") and
  // customHeaders (optional string[]) enable authenticated fuzzing --
  // forwarded on every request this run makes, discovery included, so an
  // OpenAPI document or page only visible when authenticated is still
  // found. Never logged, never included in any observation this returns.
  async execute({ target, timeoutMs = 30_000, baseProfile = 'STANDARD', customMaxParameters, userPlan: externalUserPlan = [], adaptivePlan: externalAdaptivePlan, authProfileId, authHeader, customHeaders = [], signal, onProgress }) {
    const throwIfCancelled = () => {
      if (!signal?.aborted) return;
      const error = new Error('Smart Fuzz execution cancelled by user');
      error.name = 'AbortError';
      throw error;
    };
    throwIfCancelled();
    const validatedTarget = assertHttpTarget(target);
    const authProfile = resolveAuthProfile(authProfileId);
    const headers = [...authProfile.headers, ...(authHeader ? [authHeader] : []), ...customHeaders];
    const probeTimeoutMs = Math.min(timeoutMs, 7_000);

    const { endpoints, openapiSource } = await discoverEndpoints(validatedTarget, { timeoutMs: probeTimeoutMs, headers });
    throwIfCancelled();

    const raw = [];
    const discoveredNotExecuted = endpoints.filter((e) => !e.executable);
    for (const endpoint of discoveredNotExecuted) {
      raw.push({
        type: 'HTTP_FUZZ_DISCOVERED_NOT_EXECUTED', method: endpoint.method, endpoint: endpoint.url,
        parameters: endpoint.params.map((p) => p.name), source: endpoint.source,
        reason: `${endpoint.method} is a mutating method -- BCI Smart Fuzz stays SAFE_ACTIVE and never sends it to a real target`,
      });
    }

    // BASE is built first and unconditionally -- nothing below this line
    // can shrink it. AI_ADAPTIVE, if present, is a strictly additional set
    // layered on top, on its own independent budget.
    const baseScope = resolveFuzzBaseScope(baseProfile, customMaxParameters);
    const basePlan = buildBasePlan(endpoints, baseScope);
    const userPlan = sanitizeUserPlan(externalUserPlan, endpoints);
    const adaptivePlan = externalAdaptivePlan ? sanitizeAdaptivePlan(externalAdaptivePlan, endpoints) : [];
    const plan = [...basePlan, ...userPlan, ...adaptivePlan];

    if (plan.length === 0) {
      if (discoveredNotExecuted.length > 0) return { raw }; // real discovery happened, just nothing GET-executable to probe
      throw new Error('no fuzzable endpoint/parameter discovered for this target');
    }

    const baselines = new Map(); // `${method} ${url}` -> {status, sizeBytes, timeMs}
    const discoveredObservationCount = raw.length;
    let failures = 0;
    let completed = 0;
    const emitProgress = async (phase = 'PROBING') => {
      if (!onProgress) return;
      await onProgress({ phase, completed, total: plan.length, failures });
    };
    const buildFailureObservation = () => {
      const completedRaw = raw.filter(Boolean);
      return ({
      raw: completedRaw,
      discoveryMeta: {
        endpointsDiscovered: endpoints.length, openapiSource,
        baseProbesPlanned: basePlan.length, userProbesPlanned: userPlan.length, adaptiveProbesPlanned: adaptivePlan.length,
        probesPlanned: plan.length, probesCompleted: completed,
        requestedScope: { baseProfile, customMaxParameters: customMaxParameters ?? null, authProfileId: authProfile.profileId },
        executedScope: { baseProfile: baseScope.baseProfile, maxParameters: baseScope.maxParameters, parametersCovered: new Set(basePlan.map((entry) => `${entry.url}|${entry.location}|${entry.parameter}`)).size },
        failureSummary: summarizeHttpFuzzFailures(completedRaw), partial: completed < plan.length,
      },
    });
    };

    await emitProgress('PROBING');
    let nextIndex = 0;
    const runProbe = async (entry, planIndex) => {
      throwIfCancelled();
      const baselineKey = `${entry.method} ${entry.url}`;
      if (!baselines.has(baselineKey)) {
        try {
          const baseline = await curlFetch(entry.url, { method: entry.method, headers, timeoutMs: probeTimeoutMs });
          baselines.set(baselineKey, baseline);
        } catch (err) {
          baselines.set(baselineKey, { status: null, sizeBytes: null, timeMs: null, body: '', error: String(err.message || err) });
        }
      }
      const baseline = baselines.get(baselineKey);
      const category = getCategory(entry.categoryId);

      try {
        const { url, headers: probeHeaders } = applyProbe(entry.url, entry.location, entry.parameter, category.value, headers);
        const result = await curlFetch(url, { method: entry.method, headers: probeHeaders, timeoutMs: probeTimeoutMs });

        const reasons = [];
        if (result.status >= 500) reasons.push('server_error');
        if (baseline.sizeBytes != null && baseline.sizeBytes > 0) {
          const ratio = result.sizeBytes / baseline.sizeBytes;
          if (ratio >= SIZE_DELTA_RATIO || ratio <= 1 / SIZE_DELTA_RATIO) reasons.push('response_size_deviation');
        }
        if (baseline.timeMs != null && result.timeMs - baseline.timeMs >= TIME_DELTA_MS) reasons.push('latency_deviation');
        const reflected = !!category.reflectionMarker && result.body.includes(category.reflectionMarker);
        if (reflected) reasons.push('payload_reflected_unescaped');

        raw[discoveredObservationCount + planIndex] = {
          type: 'HTTP_FUZZ_PROBE', method: entry.method, endpoint: entry.url, parameter: entry.parameter, location: entry.location,
          category: entry.categoryId, source: entry.source, status: result.status, sizeBytes: result.sizeBytes, timeMs: result.timeMs,
          baselineStatus: baseline.status, baselineSizeBytes: baseline.sizeBytes, baselineTimeMs: baseline.timeMs,
          reflected, anomalous: reasons.length > 0, anomalyReasons: reasons,
        };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        failures += 1;
        raw[discoveredObservationCount + planIndex] = {
          type: 'HTTP_FUZZ_PROBE', method: entry.method, endpoint: entry.url, parameter: entry.parameter, location: entry.location,
          category: entry.categoryId, source: entry.source, status: null, anomalous: false, anomalyReasons: [],
          errorCode: classifyHttpFuzzFailure(err), error: safeFailureDetail(err),
        };
      }
      completed += 1;
      if (completed === plan.length || completed % 5 === 0) await emitProgress();
    };

    const workers = Array.from({ length: Math.min(MAX_PROBE_CONCURRENCY, plan.length) }, async () => {
      while (nextIndex < plan.length) {
        const planIndex = nextIndex++;
        await runProbe(plan[planIndex], planIndex);
      }
    });
    try {
      await Promise.all(workers);
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        err.failureObservation = buildFailureObservation();
        err.completedObservations = completed;
      }
      throw err;
    }

    if (failures === plan.length) {
      const failureSummary = summarizeHttpFuzzFailures(raw);
      const counts = Object.entries(failureSummary.counts).map(([code, count]) => `${code}: ${count}`).join(', ');
      const error = new Error(`all HTTP fuzz probes failed (${counts || 'HTTP_TRANSPORT'})`);
      // The pipeline persists this immutable, non-finding observation before
      // recording the engine as FAILED. This keeps the real transport cause
      // available to API/UI/reporting without pretending a failed probe was a
      // vulnerability or a successful engine execution.
      error.failureObservation = buildFailureObservation();
      throw error;
    }
    return {
      raw,
      discoveryMeta: {
        endpointsDiscovered: endpoints.length, openapiSource,
        baseProbesRun: basePlan.length, userProbesRun: userPlan.length, adaptiveProbesRun: adaptivePlan.length, probesRun: plan.length,
        requestedScope: { baseProfile, customMaxParameters: customMaxParameters ?? null, authProfileId: authProfile.profileId },
        executedScope: { baseProfile: baseScope.baseProfile, maxParameters: baseScope.maxParameters, parametersCovered: new Set(basePlan.map((entry) => `${entry.url}|${entry.location}|${entry.parameter}`)).size },
      },
    };
  },
};
