import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { runLoad, computeMetrics, analyzeDegradation, clampPlan, loadShapeIntensity, REQUEST_COUNT_OPTIONS, LOAD_PLAN_CAPABILITIES } from '../src/engines/resilience/loadEngine.js';

let server;
let port;
let concurrentNow = 0;
let maxConcurrentSeen = 0;
let requestCount = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    concurrentNow += 1;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentNow);
    const delay = req.url === '/slow' ? 250 : 5;
    setTimeout(() => {
      concurrentNow -= 1;
      if (req.url === '/error') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', server: 'bci-test-server' });
      res.end('ok');
    }, delay);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('BCI Smart Resilience — plan validation without product clamping', () => {
  it('honors a requested plan exactly', () => {
    const { requestedPlan, executedPlan, clamps } = clampPlan({ totalRequests: 100, concurrency: 10, targetRps: 20, durationMs: 5000 });
    expect(executedPlan.totalRequests).toBe(100);
    expect(executedPlan.concurrency).toBe(10);
    expect(clamps).toEqual([]);
    expect(requestedPlan.totalRequests).toBe(100);
  });

  it('does not shrink values above the former product ceilings', () => {
    const { requestedPlan, executedPlan, clamps } = clampPlan({ totalRequests: 99_999, concurrency: 500, targetRps: 9999, durationMs: 999_999 });
    expect(executedPlan).toEqual(requestedPlan);
    expect(executedPlan).toMatchObject({ totalRequests: 99_999, concurrency: 500, targetRps: 9999, durationMs: 999_999 });
    expect(clamps).toEqual([]);
  });

  it('publishes all fixed, custom, and unlimited request-count choices', () => {
    expect(REQUEST_COUNT_OPTIONS.map((option) => option.id)).toEqual(['100', '500', '1000', '5000', '10000', 'CUSTOM', 'UNLIMITED']);
  });

  it('publishes every real load shape through the canonical Wizard/API contract', () => {
    expect(LOAD_PLAN_CAPABILITIES.profileOptions.map((option) => option.id)).toEqual([
      'constant', 'ramp_up', 'ramp_down', 'step', 'spike', 'burst', 'sustained',
    ]);
    expect(() => clampPlan({ profile: 'imaginary' })).toThrow(/unsupported load profile/);
  });

  it('represents UNLIMITED with no totalRequests or duration bound', () => {
    const { requestedPlan, executedPlan } = clampPlan({ requestCountMode: 'UNLIMITED', totalRequests: null, durationMs: null, concurrency: 75, targetRps: 250 });
    expect(requestedPlan.totalRequests).toBeNull();
    expect(executedPlan).toEqual(requestedPlan);
  });

  it('rejects invalid plans explicitly instead of silently correcting them', () => {
    expect(() => clampPlan({ concurrency: 0 })).toThrow(/concurrency/);
    expect(() => clampPlan({ rampUpMs: 6000, rampDownMs: 6000, durationMs: 10_000 })).toThrow(/cannot exceed/);
  });
});

describe('BCI Smart Resilience — loadShapeIntensity (real, distinct profile shapes)', () => {
  it('ramp_up rises linearly from 0 to 1 over rampUpMs, then holds at 1', () => {
    const plan = { durationMs: 10_000, rampUpMs: 8000, rampDownMs: 0 };
    expect(loadShapeIntensity('ramp_up', 0, plan)).toBe(0);
    expect(loadShapeIntensity('ramp_up', 4000, plan)).toBeCloseTo(0.5, 2);
    expect(loadShapeIntensity('ramp_up', 8000, plan)).toBe(1);
    expect(loadShapeIntensity('ramp_up', 9000, plan)).toBe(1);
  });

  it('ramp_down holds at 1, then falls linearly to 0 over the final rampDownMs', () => {
    const plan = { durationMs: 10_000, rampUpMs: 0, rampDownMs: 4000 };
    expect(loadShapeIntensity('ramp_down', 0, plan)).toBe(1);
    expect(loadShapeIntensity('ramp_down', 6000, plan)).toBe(1);
    expect(loadShapeIntensity('ramp_down', 8000, plan)).toBeCloseTo(0.5, 2);
    expect(loadShapeIntensity('ramp_down', 10_000, plan)).toBe(0);
  });

  it('spike stays at a low baseline except for a real, distinct high-intensity window in the middle', () => {
    const plan = { durationMs: 10_000 };
    expect(loadShapeIntensity('spike', 0, plan)).toBe(0.2);
    expect(loadShapeIntensity('spike', 5000, plan)).toBe(1);
    expect(loadShapeIntensity('spike', 9000, plan)).toBe(0.2);
  });

  it('burst runs at full intensity briefly then drops to zero -- distinct from spike\'s nonzero baseline', () => {
    const plan = { durationMs: 10_000 };
    expect(loadShapeIntensity('burst', 1000, plan)).toBe(1);
    expect(loadShapeIntensity('burst', 8000, plan)).toBe(0);
  });

  it('constant/sustained stay at full intensity for the whole run', () => {
    const plan = { durationMs: 10_000 };
    expect(loadShapeIntensity('constant', 0, plan)).toBe(1);
    expect(loadShapeIntensity('sustained', 9999, plan)).toBe(1);
  });
});

describe('BCI Smart Resilience — runLoad (real concurrent HTTP execution against a local server)', () => {
  it('runs without a request cap until an AbortSignal stops it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 350);
    const result = await runLoad({
      targets: [`http://127.0.0.1:${port}/`],
      plan: { totalRequests: null, concurrency: 10, targetRps: 100, durationMs: null, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('USER_CANCELLED');
    expect(result.samples.length).toBeGreaterThan(0);
  });
  it('actually sends the requested number of real requests, never fewer, never fabricated', async () => {
    requestCount = 0;
    const { samples } = await runLoad({
      targets: [`http://127.0.0.1:${port}/`],
      plan: { totalRequests: 60, concurrency: 10, targetRps: 40, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    expect(samples).toHaveLength(60);
    expect(requestCount).toBe(60); // the real server actually received exactly this many requests
    expect(samples.every((s) => s.status === 200)).toBe(true);
  }, 15_000);

  it('real concurrency never exceeds the plan\'s concurrency ceiling', async () => {
    maxConcurrentSeen = 0;
    await runLoad({
      targets: [`http://127.0.0.1:${port}/slow`],
      plan: { totalRequests: 40, concurrency: 8, targetRps: 40, durationMs: 4000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    expect(maxConcurrentSeen).toBeLessThanOrEqual(8);
    expect(maxConcurrentSeen).toBeGreaterThan(1); // real concurrency actually happened, not sequential
  }, 15_000);

  it('a real request timeout is honored -- a slow endpoint with a tight timeout produces real timedOut samples, not fake successes', async () => {
    const { samples } = await runLoad({
      targets: [`http://127.0.0.1:${port}/slow`],
      plan: { totalRequests: 15, concurrency: 5, targetRps: 15, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 50, profile: 'constant' },
      headers: [],
    });
    expect(samples.some((s) => s.timedOut === true)).toBe(true);
    expect(samples.every((s) => s.timedOut ? s.status === null : true)).toBe(true);
  }, 15_000);

  it('real HTTP errors (5xx) are captured as real completed samples with the real status code, not hidden as failures', async () => {
    const { samples } = await runLoad({
      targets: [`http://127.0.0.1:${port}/error`],
      plan: { totalRequests: 10, concurrency: 5, targetRps: 20, durationMs: 2000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    expect(samples.every((s) => s.status === 500)).toBe(true);
  }, 15_000);

  it('round-robins real requests across multiple real target endpoints', async () => {
    const hits = { '/a': 0, '/b': 0 };
    const server2 = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const port2 = server2.address().port;
    await runLoad({
      targets: [`http://127.0.0.1:${port2}/a`, `http://127.0.0.1:${port2}/b`],
      plan: { totalRequests: 20, concurrency: 5, targetRps: 20, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    server2.close();
    expect(hits['/a']).toBeGreaterThan(0);
    expect(hits['/b']).toBeGreaterThan(0);
    expect(hits['/a'] + hits['/b']).toBe(20);
  }, 15_000);
});

describe('BCI Smart Resilience — computeMetrics / analyzeDegradation (real measurement, not estimation)', () => {
  it('computes real percentile latency and status distribution from real samples', async () => {
    const { samples, actualDurationMs } = await runLoad({
      targets: [`http://127.0.0.1:${port}/`],
      plan: { totalRequests: 50, concurrency: 10, targetRps: 30, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    const metrics = computeMetrics(samples, actualDurationMs);
    expect(metrics.completed).toBe(50);
    expect(metrics.statusDistribution['200']).toBe(50);
    expect(metrics.p50LatencyMs).toBeGreaterThan(0);
    expect(metrics.p99LatencyMs).toBeGreaterThanOrEqual(metrics.p50LatencyMs);
    expect(metrics.minLatencyMs).toBeLessThanOrEqual(metrics.maxLatencyMs);
    expect(metrics.errorRate).toBe(0);
  }, 15_000);

  it('detects real latency degradation on a genuinely slow endpoint vs. a fast one', async () => {
    const fast = await runLoad({
      targets: [`http://127.0.0.1:${port}/`],
      plan: { totalRequests: 40, concurrency: 10, targetRps: 30, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    const slow = await runLoad({
      targets: [`http://127.0.0.1:${port}/slow`],
      plan: { totalRequests: 40, concurrency: 10, targetRps: 30, durationMs: 3000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 5000, profile: 'constant' },
      headers: [],
    });
    const fastMetrics = computeMetrics(fast.samples, fast.actualDurationMs);
    const slowMetrics = computeMetrics(slow.samples, slow.actualDurationMs);
    expect(slowMetrics.avgLatencyMs).toBeGreaterThan(fastMetrics.avgLatencyMs * 3);
  }, 20_000);

  it('returns INCONCLUSIVE degradation analysis for too few real samples, never a fabricated signal', () => {
    expect(analyzeDegradation([{ startedAt: 0, endedAt: 10, status: 200 }], 1000).signal).toBe('INCONCLUSIVE');
  });
});
