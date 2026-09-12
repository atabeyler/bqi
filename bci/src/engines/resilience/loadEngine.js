import http from 'node:http';
import https from 'node:https';
import { setMaxListeners } from 'node:events';

// Canonical API/Wizard request-count choices. These are choices, not product
// ceilings: CUSTOM and UNLIMITED deliberately have no numeric maximum.
export const REQUEST_COUNT_OPTIONS = Object.freeze([
  { id: '100', totalRequests: 100 },
  { id: '500', totalRequests: 500 },
  { id: '1000', totalRequests: 1000 },
  { id: '5000', totalRequests: 5000 },
  { id: '10000', totalRequests: 10_000 },
  { id: 'CUSTOM', totalRequests: null },
  { id: 'UNLIMITED', totalRequests: null },
]);

export const LOAD_PROFILE_OPTIONS = Object.freeze([
  { id: 'constant', name: 'Constant' },
  { id: 'ramp_up', name: 'Ramp Up' },
  { id: 'ramp_down', name: 'Ramp Down' },
  { id: 'step', name: 'Step' },
  { id: 'spike', name: 'Spike' },
  { id: 'burst', name: 'Burst' },
  { id: 'sustained', name: 'Sustained' },
]);

export const LOAD_PLAN_CAPABILITIES = Object.freeze({
  requestCountOptions: REQUEST_COUNT_OPTIONS,
  profileOptions: LOAD_PROFILE_OPTIONS,
  adjustableFields: ['totalRequests', 'concurrency', 'targetRps', 'durationMs', 'requestTimeoutMs', 'rampUpMs', 'rampDownMs', 'profile'],
  unlimitedSupportsUserCancellation: true,
  productMaxima: null,
});

const DEFAULT_PLAN = {
  requestCountMode: '100',
  totalRequests: 100,
  concurrency: 10,
  targetRps: 20,
  durationMs: 10_000,
  rampUpMs: 0,
  rampDownMs: 0,
  requestTimeoutMs: 5_000,
  profile: 'constant',
};

const REQUEST_COUNT_IDS = new Set(REQUEST_COUNT_OPTIONS.map((option) => option.id));
const LOAD_PROFILE_IDS = new Set(LOAD_PROFILE_OPTIONS.map((option) => option.id));

function assertPositiveNumber(plan, field, { integer = false, nullable = false } = {}) {
  const value = plan[field];
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${field} must be ${integer ? 'a positive integer' : 'a positive finite number'}${nullable ? ' or null' : ''}`);
  }
}

// Compatibility name retained because modules and external callers already
// use clampPlan(). It now validates and canonicalizes the plan without ever
// lowering an ADMIN-selected value. Invalid plans are rejected explicitly.
export function clampPlan(requested = {}) {
  const inferredMode = requested.requestCountMode
    ?? (requested.totalRequests === null ? 'UNLIMITED' : requested.totalRequests === undefined ? DEFAULT_PLAN.requestCountMode : 'CUSTOM');
  const merged = { ...DEFAULT_PLAN, ...requested, requestCountMode: String(inferredMode).toUpperCase() };
  if (!REQUEST_COUNT_IDS.has(merged.requestCountMode)) throw new TypeError(`unsupported requestCountMode: ${merged.requestCountMode}`);

  const preset = REQUEST_COUNT_OPTIONS.find((option) => option.id === merged.requestCountMode);
  if (preset?.totalRequests != null) {
    if (requested.totalRequests != null && requested.totalRequests !== preset.totalRequests) {
      throw new TypeError(`totalRequests must equal ${preset.totalRequests} for requestCountMode ${merged.requestCountMode}`);
    }
    merged.totalRequests = preset.totalRequests;
  } else if (merged.requestCountMode === 'UNLIMITED') {
    if (requested.totalRequests != null) throw new TypeError('totalRequests must be null or omitted for UNLIMITED mode');
    merged.totalRequests = null;
  } else {
    assertPositiveNumber(merged, 'totalRequests', { integer: true });
  }

  assertPositiveNumber(merged, 'totalRequests', { integer: true, nullable: merged.requestCountMode === 'UNLIMITED' });
  assertPositiveNumber(merged, 'concurrency', { integer: true });
  assertPositiveNumber(merged, 'targetRps');
  assertPositiveNumber(merged, 'durationMs', { integer: true, nullable: true });
  assertPositiveNumber(merged, 'requestTimeoutMs', { integer: true });
  for (const field of ['rampUpMs', 'rampDownMs']) {
    if (!Number.isInteger(merged[field]) || merged[field] < 0) throw new TypeError(`${field} must be a non-negative integer`);
  }
  if (merged.durationMs !== null && merged.rampUpMs + merged.rampDownMs > merged.durationMs) {
    throw new TypeError('rampUpMs + rampDownMs cannot exceed durationMs');
  }
  if (!LOAD_PROFILE_IDS.has(merged.profile)) throw new TypeError(`unsupported load profile: ${merged.profile}`);

  const executed = { ...merged };
  const clamps = [];
  return { requestedPlan: merged, executedPlan: executed, clamps };
}

// Real load-shape intensity (0..1) at elapsed time t, for the given
// profile -- multiplies targetRps at each scheduling tick (see runLoad).
// This is what makes BCI Smart Resilience genuinely dynamic rather than a
// single fixed-rate generator: each profile produces a real, different
// request-arrival pattern over the same wall-clock duration.
export function loadShapeIntensity(profile, elapsedMs, plan) {
  const { durationMs, rampUpMs, rampDownMs } = plan;
  // Durationless UNLIMITED runs repeat finite shapes instead of silently
  // inventing a stop time. Constant/sustained profiles are unaffected.
  const shapeDurationMs = durationMs ?? plan.profileCycleMs ?? 10_000;
  const shapeElapsedMs = durationMs === null ? elapsedMs % shapeDurationMs : elapsedMs;
  switch (profile) {
    case 'ramp_up':
      return rampUpMs > 0 ? Math.min(1, shapeElapsedMs / rampUpMs) : 1;
    case 'ramp_down': {
      const rampStart = shapeDurationMs - rampDownMs;
      if (shapeElapsedMs < rampStart) return 1;
      return rampDownMs > 0 ? Math.max(0, 1 - (shapeElapsedMs - rampStart) / rampDownMs) : 0;
    }
    case 'ramp': {
      if (rampUpMs > 0 && shapeElapsedMs < rampUpMs) return shapeElapsedMs / rampUpMs;
      const rampDownStart = shapeDurationMs - rampDownMs;
      if (rampDownMs > 0 && shapeElapsedMs >= rampDownStart) return Math.max(0, 1 - (shapeElapsedMs - rampDownStart) / rampDownMs);
      return 1;
    }
    case 'step': {
      const steps = 5;
      const stepIndex = Math.min(steps - 1, Math.floor((shapeElapsedMs / shapeDurationMs) * steps));
      return (stepIndex + 1) / steps;
    }
    case 'spike': {
      const spikeStart = shapeDurationMs * 0.4;
      const spikeEnd = shapeDurationMs * 0.6;
      return shapeElapsedMs >= spikeStart && shapeElapsedMs <= spikeEnd ? 1 : 0.2;
    }
    case 'burst':
      return shapeElapsedMs <= shapeDurationMs * 0.3 ? 1 : 0;
    case 'constant':
    case 'sustained':
    default:
      return 1;
  }
}

function buildHeaders(headers) {
  const obj = {};
  for (const h of headers || []) {
    const idx = h.indexOf(':');
    if (idx === -1) continue;
    obj[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return obj;
}

// One real HTTP request, issued via Node's own http/https client (not a
// spawned curl process -- real concurrent load at hundreds of requests
// needs a real connection-pooled client, not one OS process per request).
// Response bodies are discarded (res.resume()) -- load testing measures
// network/server behavior, not response content, and never buffers
// arbitrary response bodies under load.
function issueRequest(url, { method = 'GET', headers = [], timeoutMs, agent, signal }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      resolve({ startedAt, endedAt: Date.now(), status: null, timedOut: false, connectionError: String(err.message || err), responseHeaders: {} });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    const req = lib.request(target, { method, headers: buildHeaders(headers), agent, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve({ startedAt, endedAt: Date.now(), status: res.statusCode, timedOut: false, aborted: false, connectionError: null, responseHeaders: res.headers });
      });
    });
    const abort = () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ startedAt, endedAt: Date.now(), status: null, timedOut: false, aborted: true, connectionError: null, responseHeaders: {} });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      signal?.removeEventListener('abort', abort);
      resolve({ startedAt, endedAt: Date.now(), status: null, timedOut: true, aborted: false, connectionError: null, responseHeaders: {} });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve({ startedAt, endedAt: Date.now(), status: null, timedOut: false, aborted: false, errorCode: err.code ?? null, connectionError: String(err.message || err), responseHeaders: {} });
    });
    req.end();
  });
}

const TICK_MS = 100;

// The real load generator. Runs a genuine, concurrency-bounded,
// rate-paced, profile-shaped stream of HTTP requests against one or more
// real targets for the executed plan's real duration -- every sample
// returned corresponds to a request BCI actually sent and actually
// observed the outcome of; nothing here is synthesized.
//
// targets: string[] -- one or more real endpoint URLs (round-robin) --
// see MULTI_ENDPOINT/CROSS_ENGINE_TARGETED_RESILIENCE modules.
export async function runLoad({ targets, plan, headers = [], onProgress, signal }) {
  const { totalRequests, concurrency, targetRps, durationMs, requestTimeoutMs, profile } = plan;
  const agent = targets[0]?.startsWith('https:')
    ? new https.Agent({ keepAlive: true, maxSockets: concurrency })
    : new http.Agent({ keepAlive: true, maxSockets: concurrency });
  if (signal) setMaxListeners(Math.max(10, concurrency + 5), signal);

  const samples = [];
  let issued = 0;
  let inFlight = 0;
  const startedAt = Date.now();
  let targetIndex = 0;
  let requestCredit = 0;
  let stopReason = null;

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const durationElapsed = durationMs !== null && elapsedMs >= durationMs;
      const requestsExhausted = totalRequests !== null && issued >= totalRequests;
      if (signal?.aborted || durationElapsed || requestsExhausted) {
        stopReason = signal?.aborted ? 'USER_CANCELLED' : durationElapsed ? 'DURATION' : 'TOTAL_REQUESTS';
        clearInterval(timer);
        // Wait for in-flight requests to settle before resolving.
        const waitForDrain = setInterval(() => {
          if (inFlight <= 0) {
            clearInterval(waitForDrain);
            resolve();
          }
        }, 20);
        return;
      }

      const intensity = loadShapeIntensity(profile, elapsedMs, plan);
      const ticksPerSecond = 1000 / TICK_MS;
      requestCredit += (targetRps * intensity) / ticksPerSecond;
      const requestsThisTick = Math.floor(requestCredit);
      requestCredit -= requestsThisTick;
      const availableConcurrency = Math.max(0, concurrency - inFlight);
      const remaining = totalRequests === null ? Number.POSITIVE_INFINITY : totalRequests - issued;
      const toFire = Math.max(0, Math.min(requestsThisTick, availableConcurrency, remaining));

      for (let i = 0; i < toFire; i += 1) {
        issued += 1;
        inFlight += 1;
        const url = targets[targetIndex % targets.length];
        targetIndex += 1;
        issueRequest(url, { headers, timeoutMs: requestTimeoutMs, agent, signal }).then((sample) => {
          inFlight -= 1;
          samples.push({ ...sample, endpoint: url });
          if (onProgress) onProgress({ issued, completed: samples.length, elapsedMs: Date.now() - startedAt });
        });
      }
    }, TICK_MS);
  });

  agent.destroy();
  return { samples, scheduled: issued, actualDurationMs: Date.now() - startedAt, stopReason };
}

// Real percentile/latency/status/error metrics over a real sample set --
// no metric here is estimated or interpolated from anything but the
// actual recorded samples.
export function computeMetrics(samples, actualDurationMs) {
  const completed = samples.filter((s) => s.status != null);
  const timedOut = samples.filter((s) => s.timedOut);
  const connectionErrors = samples.filter((s) => !s.timedOut && s.connectionError);
  const failed = samples.filter((s) => s.status == null);

  const latencies = completed.map((s) => s.endedAt - s.startedAt).sort((a, b) => a - b);
  const percentile = (p) => {
    if (latencies.length === 0) return null;
    const idx = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1);
    return latencies[Math.max(0, idx)];
  };

  const statusDistribution = {};
  for (const s of completed) statusDistribution[s.status] = (statusDistribution[s.status] || 0) + 1;

  const durationSec = Math.max(0.001, actualDurationMs / 1000);
  const backendIdentifiers = new Set(completed.map((s) => s.responseHeaders?.['server'] || s.responseHeaders?.['x-served-by'] || s.responseHeaders?.['via']).filter(Boolean));

  return {
    requested: samples.length ? samples.length : 0,
    attempted: samples.length,
    completed: completed.length,
    failed: failed.length - timedOut.length, // failed-with-a-connection-error, distinct from timedOut
    timedOut: timedOut.length,
    connectionErrors: connectionErrors.length,
    statusDistribution,
    rateLimitedCount: statusDistribution[429] || 0,
    actualRps: samples.length / durationSec,
    throughput: completed.length / durationSec,
    p50LatencyMs: percentile(50), p90LatencyMs: percentile(90), p95LatencyMs: percentile(95), p99LatencyMs: percentile(99),
    minLatencyMs: latencies[0] ?? null, maxLatencyMs: latencies[latencies.length - 1] ?? null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    errorRate: samples.length ? (failed.length) / samples.length : 0,
    timeoutRate: samples.length ? timedOut.length / samples.length : 0,
    distinctBackendIdentifiers: [...backendIdentifiers],
  };
}

// Real saturation/degradation analysis: splits the real samples into real
// time buckets and compares throughput/latency trend across them -- rising
// latency while throughput plateaus or falls is the real, standard
// capacity-limit signal (never assumed from a single aggregate number).
export function analyzeDegradation(samples, actualDurationMs, bucketCount = 4) {
  if (samples.length < bucketCount * 2) return { signal: 'INCONCLUSIVE', buckets: [] };
  const bucketMs = actualDurationMs / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const bucketStart = i * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const inBucket = samples.filter((s) => {
      const t = s.startedAt - samples[0].startedAt;
      return t >= bucketStart && t < bucketEnd;
    });
    const completed = inBucket.filter((s) => s.status != null);
    const avgLatency = completed.length ? completed.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0) / completed.length : null;
    return {
      bucket: i, requestCount: inBucket.length, completedCount: completed.length,
      avgLatencyMs: avgLatency != null ? Math.round(avgLatency) : null,
      throughput: completed.length / (bucketMs / 1000),
      errorRate: inBucket.length ? (inBucket.length - completed.length) / inBucket.length : 0,
    };
  });

  const withLatency = buckets.filter((b) => b.avgLatencyMs != null);
  if (withLatency.length < 2) return { signal: 'INCONCLUSIVE', buckets };

  const first = withLatency[0];
  const last = withLatency[withLatency.length - 1];
  const latencyRising = last.avgLatencyMs > first.avgLatencyMs * 1.5;
  const throughputFlatOrFalling = last.throughput <= first.throughput * 1.1;
  const errorsRising = last.errorRate > first.errorRate + 0.1;

  let signal = 'STABLE';
  if (errorsRising || (latencyRising && throughputFlatOrFalling)) signal = 'SATURATED';
  else if (latencyRising) signal = 'DEGRADING';

  return { signal, buckets, degradationPoint: signal !== 'STABLE' ? withLatency.findIndex((b) => b === last) : null };
}
