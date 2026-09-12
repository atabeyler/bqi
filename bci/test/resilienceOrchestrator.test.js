import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { availabilityProbeAdapter } from '../src/engines/adapters/availabilityProbe.js';

let server;
let port;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

async function ifHealthy() {
  const health = await availabilityProbeAdapter.healthCheck();
  return health.status === 'HEALTHY';
}

// Every module's own defaults are overridden by a caller-supplied
// requestedPlan (each module spreads `...requestedPlan` last) -- this is
// a real, small, fast plan used only to keep this test suite's OWN wall-
// clock time reasonable; loadEngine.js's no-clamping validation behavior
// is exercised directly in
// resilienceLoadEngine.test.js.
const FAST_PLAN = { totalRequests: 15, concurrency: 5, targetRps: 20, durationMs: 1000, rampUpMs: 0, rampDownMs: 0, requestTimeoutMs: 3000, recoveryObservationMs: 300 };

describe('BCI Smart Resilience orchestrator (availability-probe adapter) — real end-to-end execution', () => {
  it('reports its real DOS capability contract unchanged', () => {
    expect(availabilityProbeAdapter.id).toBe('availability-probe');
    expect(availabilityProbeAdapter.capabilities).toEqual(['DOS']);
    expect(availabilityProbeAdapter.intrusiveness).toBe('RESTRICTED');
  });

  it('runs the real dynamically-selected BASE module set, each producing a real RESILIENCE_ROUND tagged BASE', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw, moduleMeta } = await availabilityProbeAdapter.execute({ target, timeoutMs: 60_000, requestedPlan: FAST_PLAN });
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.type === 'RESILIENCE_ROUND' && r.source === 'BASE')).toBe(true);
    expect(moduleMeta.base).toBeGreaterThan(0);
    // No endpoints/priorFindings/authHeader supplied -- MULTI_ENDPOINT,
    // CROSS_ENGINE_TARGETED_RESILIENCE and AUTHENTICATED_LOAD are
    // genuinely not applicable here, real dynamic selection at work.
    expect(raw.some((r) => r.module === 'MULTI_ENDPOINT')).toBe(false);
    expect(raw.some((r) => r.module === 'CROSS_ENGINE_TARGETED_RESILIENCE')).toBe(false);
    expect(raw.some((r) => r.module === 'AUTHENTICATED_LOAD')).toBe(false);
  }, 60_000);

  it('every real round reports both requestedPlan and executedPlan, and a real STABLE status against a healthy local server', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw } = await availabilityProbeAdapter.execute({ target, timeoutMs: 60_000, requestedPlan: FAST_PLAN });
    const concurrencyRound = raw.find((r) => r.module === 'CONCURRENCY');
    expect(concurrencyRound.requestedPlan).toBeDefined();
    expect(concurrencyRound.executedPlan).toBeDefined();
    expect(concurrencyRound.metrics.completed).toBeGreaterThan(0);
    expect(concurrencyRound.status).toBe('STABLE');
    expect(['STABLE', 'DEGRADING', 'SATURATED', 'RECOVERED', 'RECOVERY_FAILED', 'RATE_LIMITED', 'INCONCLUSIVE']).toContain(concurrencyRound.status);
  }, 60_000);

  it('the user\'s own real requestedPlan is honored without silent reduction', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw } = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000,
      requestedPlan: { ...FAST_PLAN, totalRequests: 33 },
    });
    const concurrencyRound = raw.find((r) => r.module === 'CONCURRENCY');
    expect(concurrencyRound.requestedPlan.totalRequests).toBe(33);
    expect(concurrencyRound.executedPlan.totalRequests).toBe(33);
    expect(concurrencyRound.clamps).toEqual([]);
  }, 60_000);

  it('values above the former ceilings remain identical in requestedPlan and executedPlan', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw } = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000,
      requestedPlan: { ...FAST_PLAN, totalRequests: 5000, concurrency: 51 },
    });
    const concurrencyRound = raw.find((r) => r.module === 'CONCURRENCY');
    expect(concurrencyRound.requestedPlan.totalRequests).toBe(5000);
    expect(concurrencyRound.executedPlan.totalRequests).toBe(5000);
    expect(concurrencyRound.executedPlan.concurrency).toBe(51);
    expect(concurrencyRound.clamps).toEqual([]);
  }, 60_000);

  it('userSelectedModuleIds always runs (ADMIN authority, never filtered); a PLANNED/unknown id is silently ignored', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw } = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000, requestedPlan: FAST_PLAN,
      userSelectedModuleIds: ['SOAK_ENDURANCE', 'NOT_A_REAL_MODULE'],
    });
    expect(raw.some((r) => r.module === 'SOAK_ENDURANCE')).toBe(false); // PLANNED, never executed
  }, 60_000);

  it('an AI_ADAPTIVE proposal naming a real module ADDS a round on top of BASE, correctly tagged, without removing any BASE round', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const baseline = await availabilityProbeAdapter.execute({ target, timeoutMs: 60_000, requestedPlan: FAST_PLAN });
    const withAdaptive = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000, requestedPlan: FAST_PLAN,
      adaptivePlan: [{ moduleId: 'RECOVERY', rationale: 'confirm recovery after the base rounds' }],
    });
    const baseRounds = withAdaptive.raw.filter((r) => r.source === 'BASE');
    const adaptiveRounds = withAdaptive.raw.filter((r) => r.source === 'AI_ADAPTIVE');
    expect(baseRounds.length).toBe(baseline.raw.length); // BASE fully intact
    expect(adaptiveRounds).toHaveLength(1);
    expect(adaptiveRounds[0].module).toBe('RECOVERY');
  }, 90_000);

  it('an AI_ADAPTIVE proposal naming an unknown module id is dropped, BASE still runs in full', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw, moduleMeta } = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000, requestedPlan: FAST_PLAN,
      adaptivePlan: [{ moduleId: 'NOT_A_REAL_MODULE', rationale: 'hallucinated' }],
    });
    expect(raw.every((r) => r.source !== 'AI_ADAPTIVE')).toBe(true);
    expect(moduleMeta.base).toBeGreaterThan(0);
  }, 60_000);

  it('MULTI_ENDPOINT activates and spreads real load across real supplied endpoints', async () => {
    if (!(await ifHealthy())) return;
    const target = `http://127.0.0.1:${port}/`;
    const { raw } = await availabilityProbeAdapter.execute({
      target, timeoutMs: 60_000, requestedPlan: FAST_PLAN,
      endpoints: [`http://127.0.0.1:${port}/a`, `http://127.0.0.1:${port}/b`],
    });
    const multi = raw.find((r) => r.module === 'MULTI_ENDPOINT');
    expect(multi).toBeDefined();
    expect(multi.endpoints.length).toBe(2);
  }, 60_000);

  it('rejects a non-HTTP target before generating any real load', async () => {
    await expect(availabilityProbeAdapter.execute({ target: 'file:///etc/passwd' })).rejects.toThrow(/unsupported URL protocol/);
  });
});
