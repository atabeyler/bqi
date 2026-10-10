import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { listAdapters } from '../src/engines/registry.js';
import { FUZZ_CATEGORIES, BASE_MIN_TESTS_PER_PARAMETER, defaultCategoriesFor } from '../src/engines/adapters/fuzzCatalog.js';
import { buildBasePlan, classifyHttpFuzzFailure, sanitizeAdaptivePlan, sanitizeUserPlan, summarizeHttpFuzzFailures } from '../src/engines/adapters/httpFuzz.js';

// Nuclei and naabu are SAFE_ACTIVE engines -- they send real requests/TCP
// connections. The only target they touch here is a throwaway HTTP server
// this test process itself starts and owns on 127.0.0.1, so there is no
// question of scope authorization: it's self-testing against localhost, not
// scanning anything outside this process's own control.
let server;
let port;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function ifHealthy(id) {
  const adapter = listAdapters().find((a) => a.id === id);
  const health = await adapter.healthCheck();
  return { adapter, healthy: health.status === 'HEALTHY' };
}

describe('active engines against a self-owned localhost target', () => {
  it('classifies and summarizes Smart Fuzz transport failures without treating them as findings', () => {
    expect(classifyHttpFuzzFailure(new Error('curl timed out after 7000ms'))).toBe('TIMEOUT');
    expect(classifyHttpFuzzFailure(new Error('SSL certificate problem: unable to get local issuer certificate'))).toBe('TLS_VALIDATION');
    expect(classifyHttpFuzzFailure(new Error('Could not resolve host'))).toBe('DNS_RESOLUTION');
    expect(classifyHttpFuzzFailure(new Error('Connection refused'))).toBe('CONNECTION');
    expect(summarizeHttpFuzzFailures([
      { type: 'HTTP_FUZZ_PROBE', status: null, errorCode: 'TIMEOUT', endpoint: 'https://example.test/', category: 'BOUNDARY_EMPTY', error: 'curl timed out after 7000ms' },
      { type: 'HTTP_FUZZ_PROBE', status: null, errorCode: 'TIMEOUT', endpoint: 'https://example.test/', category: 'BOUNDARY_PERCENT', error: 'curl timed out after 7000ms' },
      { type: 'HTTP_FUZZ_PROBE', status: 200, errorCode: null },
    ])).toMatchObject({ total: 2, counts: { TIMEOUT: 2 } });
  });

  it('naabu detects the open loopback port', async () => {
    const { adapter, healthy } = await ifHealthy('naabu');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: '127.0.0.1', ports: `${port}`, timeoutMs: 30_000 });
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.some((r) => r.port === port)).toBe(true);
  }, 30_000);

  it('nuclei runs against the local server without error', async () => {
    const { adapter, healthy } = await ifHealthy('nuclei');
    if (!healthy) return;
    // This is a binary/adapter smoke test, so use BCI's deterministic real
    // bundled templates. STANDARD intentionally traverses the full pinned
    // official corpus and belongs in an extended scanner benchmark.
    const { raw } = await adapter.execute({
      target: `http://127.0.0.1:${port}`,
      timeoutMs: 60_000,
      scanProfile: 'BCI_BUNDLED',
    });
    expect(Array.isArray(raw)).toBe(true);
  }, 60_000);

  // availability-probe (BCI Smart Resilience) is no longer a fixed
  // 3-sample probe -- see the dedicated resilienceOrchestrator.test.js
  // (real dynamic BASE/USER/AI_ADAPTIVE execution against a local server).

  // BCI Smart Fuzz BASE coverage: real evidence that the catalog itself
  // never drops below the guaranteed minimum, for any real parameter type
  // -- an AI adaptive round only ever ADDS to this (see the dedicated
  // adaptivePlan test below), it can never be the thing providing the
  // minimum.
  it('BASE_MIN_TESTS_PER_PARAMETER is never violated by the real catalog for any parameter type', () => {
    expect(BASE_MIN_TESTS_PER_PARAMETER).toBe(8);
    expect(defaultCategoriesFor('string').length).toBeGreaterThanOrEqual(BASE_MIN_TESTS_PER_PARAMETER);
    expect(defaultCategoriesFor('integer').length).toBeGreaterThanOrEqual(BASE_MIN_TESTS_PER_PARAMETER);
  });

  // A bare target with no real query string/links/forms/OpenAPI (this
  // local server serves an identical 200 "ok" to every path) falls back to
  // the one synthetic parameter, but the BASE case count per parameter is
  // driven by the real catalog (fuzzCatalog.js), not a hard-coded 8 --
  // this asserts that dynamism directly rather than pinning a magic number
  // that would silently stop testing anything the moment the catalog
  // changes size.
  it('http-fuzz runs the real default catalog\'s generic categories, tagged BASE, against a bare localhost target', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const progress = [];
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${port}`, timeoutMs: 30_000, onProgress: async (value) => progress.push(value) });
    const expectedCount = defaultCategoriesFor('string').length;
    expect(expectedCount).toBeGreaterThanOrEqual(BASE_MIN_TESTS_PER_PARAMETER);
    expect(raw).toHaveLength(expectedCount);
    expect(raw.every((probe) => probe.type === 'HTTP_FUZZ_PROBE' && probe.parameter === 'bci_probe' && probe.location === 'query' && probe.source === 'BASE')).toBe(true);
    expect(raw.every((probe) => FUZZ_CATEGORIES.some((c) => c.id === probe.category))).toBe(true);
    // The local server returns 200 to everything with a short, constant
    // body, so nothing here should look anomalous against its own baseline.
    expect(raw.every((probe) => probe.status === 200 && probe.anomalous === false)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'PROBING', completed: expectedCount, total: expectedCount, failures: 0 });
  }, 45_000);

  it('http-fuzz discovers real query parameters already present on the target URL and fuzzes those instead of only the synthetic one', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${port}/search?q=test&page=1`, timeoutMs: 30_000 });
    const parametersProbed = new Set(raw.map((probe) => probe.parameter));
    expect(parametersProbed.has('q')).toBe(true);
    expect(parametersProbed.has('page')).toBe(true);
    expect(parametersProbed.has('bci_probe')).toBe(false); // real params were found -- no need for the synthetic fallback
    // Each real parameter still gets its full guaranteed BASE coverage --
    // discovering more real parameters never thins out any one of them.
    const byParam = new Map();
    for (const probe of raw) byParam.set(probe.parameter, (byParam.get(probe.parameter) || 0) + 1);
    expect(byParam.get('q')).toBeGreaterThanOrEqual(BASE_MIN_TESTS_PER_PARAMETER);
    expect(byParam.get('page')).toBeGreaterThanOrEqual(BASE_MIN_TESTS_PER_PARAMETER);
  }, 45_000);

  it('an AI-style adaptivePlan only ever ADDS to BASE coverage -- BASE stays complete and unmodified either way', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const target = `http://127.0.0.1:${port}/search?q=test`;
    const baseline = await adapter.execute({ target, timeoutMs: 30_000 });
    const withAdaptive = await adapter.execute({
      target, timeoutMs: 30_000,
      adaptivePlan: [{ method: 'GET', url: target, parameter: 'q', location: 'query', categoryId: 'INTEGER_OVERFLOW' }],
    });

    const baseProbesOnly = withAdaptive.raw.filter((p) => p.source === 'BASE');
    const adaptiveProbesOnly = withAdaptive.raw.filter((p) => p.source === 'AI_ADAPTIVE');
    // Exactly the same BASE coverage as when no adaptivePlan was given at all.
    expect(baseProbesOnly).toHaveLength(baseline.raw.length);
    expect(baseProbesOnly.map((p) => p.category).sort()).toEqual(baseline.raw.map((p) => p.category).sort());
    // Plus exactly the one real adaptive addition, correctly tagged.
    expect(adaptiveProbesOnly).toHaveLength(1);
    expect(adaptiveProbesOnly[0]).toMatchObject({ parameter: 'q', category: 'INTEGER_OVERFLOW', source: 'AI_ADAPTIVE' });
    expect(withAdaptive.discoveryMeta).toMatchObject({ baseProbesRun: baseline.raw.length, adaptiveProbesRun: 1 });
  }, 60_000);

  it('a USER category is additive, separately provenanced, and cannot reduce BASE coverage', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const target = `http://127.0.0.1:${port}/search?q=test`;
    const baseline = await adapter.execute({ target, timeoutMs: 30_000 });
    const withUser = await adapter.execute({
      target, timeoutMs: 30_000,
      userPlan: [{ method: 'GET', url: target, parameter: 'q', location: 'query', categoryId: 'XSS_MARKER' }],
    });
    expect(withUser.raw.filter((probe) => probe.source === 'BASE')).toHaveLength(baseline.raw.length);
    expect(withUser.raw.filter((probe) => probe.source === 'USER')).toHaveLength(1);
    expect(withUser.discoveryMeta).toMatchObject({ baseProbesRun: baseline.raw.length, userProbesRun: 1 });
  }, 60_000);

  it('keeps more than 20 valid USER probes while the independent AI_ADAPTIVE budget remains 20', () => {
    const endpoint = { method: 'GET', url: 'https://example.com/search', executable: true, params: [{ name: 'q', location: 'query', type: 'string' }] };
    const plan = Array.from({ length: 25 }, (_, index) => ({
      method: 'GET', url: endpoint.url, parameter: 'q', location: 'query',
      categoryId: FUZZ_CATEGORIES[index % FUZZ_CATEGORIES.length].id,
    }));
    expect(sanitizeUserPlan(plan, [endpoint])).toHaveLength(25);
    expect(sanitizeUserPlan(plan, [endpoint]).every((entry) => entry.source === 'USER')).toBe(true);
    expect(sanitizeAdaptivePlan(plan, [endpoint])).toHaveLength(20);
    expect(sanitizeAdaptivePlan(plan, [endpoint]).every((entry) => entry.source === 'AI_ADAPTIVE')).toBe(true);
  });

  it('FULL and CUSTOM BASE scopes preserve every parameter while STANDARD remains 15', () => {
    const endpoints = Array.from({ length: 30 }, (_, index) => ({
      method: 'GET', url: `https://example.com/search-${index}`, executable: true,
      params: [{ name: `q${index}`, location: 'query', type: 'string' }],
    }));
    const perParameter = defaultCategoriesFor('string').length;
    expect(buildBasePlan(endpoints)).toHaveLength(15 * perParameter);
    expect(buildBasePlan(endpoints, { baseProfile: 'FULL' })).toHaveLength(30 * perParameter);
    expect(buildBasePlan(endpoints, { baseProfile: 'CUSTOM', customMaxParameters: 23 })).toHaveLength(23 * perParameter);
    expect(buildBasePlan(endpoints, { baseProfile: 'CUSTOM', maxParameters: 23 })).toHaveLength(23 * perParameter);
  });

  it('rejects an invalid USER endpoint/category instead of pretending it executed', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const target = `http://127.0.0.1:${port}/search?q=test`;
    await expect(adapter.execute({ target, userPlan: [{ method: 'GET', url: target, parameter: 'missing', location: 'query', categoryId: 'NOT_REAL' }] }))
      .rejects.toThrow(/invalid USER fuzz plan/);
  });

  it('honors the real scan cancellation AbortSignal before starting probes', async () => {
    const adapter = listAdapters().find((candidate) => candidate.id === 'http-fuzz');
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.execute({ target: `http://127.0.0.1:${port}/`, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a bogus adaptivePlan entry (unknown category, or a pair BCI never discovered) is dropped -- BASE still runs in full, nothing unvalidated executes', async () => {
    const { adapter, healthy } = await ifHealthy('http-fuzz');
    if (!healthy) return;
    const target = `http://127.0.0.1:${port}/search?q=test`;
    const { raw, discoveryMeta } = await adapter.execute({
      target, timeoutMs: 30_000,
      adaptivePlan: [
        { method: 'GET', url: target, parameter: 'q', location: 'query', categoryId: 'NOT_A_REAL_CATEGORY' },
        { method: 'GET', url: 'http://127.0.0.1:1/nonexistent', parameter: 'x', location: 'query', categoryId: 'BOUNDARY_EMPTY' },
      ],
    });
    expect(discoveryMeta.adaptiveProbesRun).toBe(0);
    expect(raw.every((p) => p.source !== 'AI_ADAPTIVE')).toBe(true);
    expect(raw.filter((p) => p.source === 'BASE').length).toBe(discoveryMeta.baseProbesRun);
  }, 45_000);

  it.each(['http-fuzz', 'intrusive-validation', 'availability-probe'])('%s rejects a non-HTTP target before spawning probes', async (engineId) => {
    const adapter = listAdapters().find((candidate) => candidate.id === engineId);
    await expect(adapter.execute({ target: 'file:///etc/passwd' })).rejects.toThrow(/unsupported URL protocol/);
  });
});

// A second, purpose-built local server -- deliberately crafted with real,
// observable misbehavior (permissive CORS, TRACE echo, a leaked stack
// trace, host-header trust, an access-control bypass on a normalized
// path) so BCI Smart Intrusive's modules have something genuine to
// actually detect, not just "everything returns 200 identically" like the
// bare server above.
describe('BCI Smart Intrusive against a purpose-built local server', () => {
  let intrusiveServer;
  let intrusivePort;

  beforeAll(async () => {
    intrusiveServer = http.createServer((req, res) => {
      // req.url can be a literal "//" (PATH_NORMALIZATION_VALIDATION's
      // double_slash variant against a root "/" target) or other raw
      // strings the WHATWG URL parser rejects outright (it requires a
      // real authority after "//") -- fall back to treating those as
      // simply unmatched by any special-case branch below.
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { url = { pathname: req.url }; }
      if (req.method === 'TRACE') {
        res.writeHead(200, { 'content-type': 'message/http' });
        res.end(`TRACE ${req.url} HTTP/1.1`);
        return;
      }
      if (url.pathname === '/openapi.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ openapi: '3.0.0', paths: { '/api/data': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } } } } } } }));
        return;
      }
      if (url.pathname === '/api/data') {
        const origin = req.headers.origin;
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {}),
        });
        res.end('{"ok":true}');
        return;
      }
      if (url.pathname === '/admin' && req.method === 'GET') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      if (url.pathname === '/admin//') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('admin panel -- normalization bypass');
        return;
      }
      if (url.pathname.startsWith('/bci-intrusive-nonexistent')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Traceback (most recent call last):\n  File "app.py", line 10\nKeyError: bci_probe');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => intrusiveServer.listen(0, '127.0.0.1', resolve));
    intrusivePort = intrusiveServer.address().port;
  });
  afterAll(() => new Promise((resolve) => intrusiveServer.close(resolve)));

  it('runs the real dynamically-selected BASE module set and tags every record BASE', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const target = `http://127.0.0.1:${intrusivePort}/api/data`;
    const { raw, moduleMeta } = await adapter.execute({ target, timeoutMs: 30_000 });
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.type === 'INTRUSIVE_VALIDATION_RECORD' && r.source === 'BASE')).toBe(true);
    // No priorFindings were supplied -- FINDING_REPRODUCIBILITY_VERIFICATION
    // is genuinely not applicable here, real dynamic selection at work.
    expect(raw.some((r) => r.module === 'FINDING_REPRODUCIBILITY_VERIFICATION')).toBe(false);
    expect(moduleMeta.base).toBeGreaterThan(0);
  }, 60_000);

  it('CORS_VALIDATION detects the real credentialed-origin reflection this server actually sends', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/api/data`, timeoutMs: 30_000 });
    const cors = raw.find((r) => r.module === 'CORS_VALIDATION');
    expect(cors.anomalous).toBe(true);
    expect(cors.anomalyReasons).toContain('cors_credentialed_origin_reflection');
    expect(cors.verificationStatus).toBe('VERIFIED');
  }, 30_000);

  it('HTTP_METHOD_PROTOCOL detects the real accepted TRACE method', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/`, timeoutMs: 30_000 });
    const trace = raw.find((r) => r.module === 'HTTP_METHOD_PROTOCOL' && r.testType === 'TRACE_METHOD_ACCEPTED');
    expect(trace.anomalous).toBe(true);
    expect(trace.anomalyReasons).toContain('trace_method_accepted');
  }, 30_000);

  it('ERROR_DISCLOSURE detects the real leaked Python traceback', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/`, timeoutMs: 30_000 });
    const disclosure = raw.find((r) => r.module === 'ERROR_DISCLOSURE');
    expect(disclosure.anomalous).toBe(true);
    expect(disclosure.evidence.matchedMarkers).toContain('python_traceback');
  }, 30_000);

  it('PATH_NORMALIZATION_VALIDATION detects the real 403 -> 200 bypass on the normalized variant', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/admin`, timeoutMs: 30_000 });
    const bypass = raw.find((r) => r.module === 'PATH_NORMALIZATION_VALIDATION' && r.anomalous === true);
    expect(bypass).toBeDefined();
    expect(bypass.anomalyReasons).toContain('path_normalization_access_bypass');
  }, 30_000);

  it('new Smart Intrusive modules perform real OpenAPI, cache, technology and WebSocket measurements', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const apiRun = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/api/data`, timeoutMs: 30_000 });
    const schema = apiRun.raw.find((record) => record.module === 'OPENAPI_SCHEMA_BEHAVIOR');
    expect(schema).toBeDefined();
    expect(schema.verificationStatus).toBe('VERIFIED');
    expect(schema.anomalyReasons).toContain('openapi_required_fields_missing');
    expect(apiRun.raw.some((record) => record.module === 'CACHE_PROXY_BEHAVIOR' && record.verificationStatus === 'VERIFIED')).toBe(true);
    expect(apiRun.raw.some((record) => record.module === 'TECHNOLOGY_SPECIFIC_VALIDATION' && record.verificationStatus === 'VERIFIED')).toBe(true);

    const wsRun = await adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/ws`, timeoutMs: 30_000 });
    expect(wsRun.raw.some((record) => record.module === 'WEBSOCKET_API_PROTOCOL' && record.verificationStatus === 'VERIFIED')).toBe(true);
  }, 60_000);

  it('FINDING_REPRODUCIBILITY_VERIFICATION only activates with real priorFindings and reports a real re-observed status', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const target = `http://127.0.0.1:${intrusivePort}/api/data`;
    const { raw } = await adapter.execute({
      target, timeoutMs: 30_000,
      priorFindings: [{ id: 'prior-1', title: 'CORS reflects origin', evidence: { endpoint: target, method: 'GET', httpStatus: 200 } }],
    });
    const repro = raw.find((r) => r.module === 'FINDING_REPRODUCIBILITY_VERIFICATION');
    expect(repro).toBeDefined();
    expect(repro.relatedFindingId).toBe('prior-1');
    expect(repro.evidence.reproduced).toBe(true); // status 200 still matches the original
  }, 30_000);

  it('userSelectedModuleIds runs as a separate USER round while unknown/PLANNED ids are rejected', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const target = `http://127.0.0.1:${intrusivePort}/`;
    const { raw } = await adapter.execute({
      target, timeoutMs: 30_000,
      userSelectedModuleIds: ['SECURITY_HEADER_BEHAVIOR'],
    });
    expect(raw.some((r) => r.module === 'SECURITY_HEADER_BEHAVIOR' && r.source === 'BASE')).toBe(true);
    expect(raw.some((r) => r.module === 'SECURITY_HEADER_BEHAVIOR' && r.source === 'USER')).toBe(true);
    await expect(adapter.execute({ target, userSelectedModuleIds: ['IDOR_BOLA_VALIDATION'] })).rejects.toThrow(/not applicable/);
    await expect(adapter.execute({ target, userSelectedModuleIds: ['NOT_A_REAL_MODULE'] })).rejects.toThrow(/unknown USER/);
  }, 30_000);

  it('an AI_ADAPTIVE proposal naming an unknown module id is explicitly rejected', async () => {
    const { adapter, healthy } = await ifHealthy('intrusive-validation');
    if (!healthy) return;
    const target = `http://127.0.0.1:${intrusivePort}/`;
    await expect(adapter.execute({
      target, timeoutMs: 30_000,
      adaptivePlan: [{ moduleId: 'NOT_A_REAL_MODULE', rationale: 'hallucinated' }],
    })).rejects.toThrow(/invalid AI_ADAPTIVE/);
  }, 60_000);

  it('honors scan cancellation before intrusive modules execute', async () => {
    const { adapter } = await ifHealthy('intrusive-validation');
    const controller = new AbortController(); controller.abort();
    await expect(adapter.execute({ target: `http://127.0.0.1:${intrusivePort}/`, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
