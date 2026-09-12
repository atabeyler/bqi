import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRaw, supportsEngine } from '../src/normalization/normalize.js';
import { normalizeIntrusiveValidation } from '../src/normalization/normalizers/intrusiveValidation.js';
import { normalizeAvailabilityProbe } from '../src/normalization/normalizers/availabilityProbe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/normalization', name), 'utf8'));

describe('normalization (pure functions over captured real tool output, no binaries needed)', () => {
  it('unwraps binary execution envelopes without treating scope metadata as findings', () => {
    const wrapped = normalizeRaw('naabu', { raw: [{ ip: '127.0.0.1', port: 443, protocol: 'tcp' }], executionMeta: { resultCount: 1 } });
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].capabilityId).toBe('NETWORK_DISCOVERY');
  });
  it('rejects an engine id with no registered normalizer', () => {
    expect(supportsEngine('nonexistent-engine')).toBe(false);
    expect(() => normalizeRaw('nonexistent-engine', {})).toThrow();
  });

  it('normalizes real Trivy vulnerability findings', () => {
    const observations = normalizeRaw('trivy', load('trivy.json'));
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.category === 'SCA' && o.component === 'lodash')).toBe(true);
    const known = observations.find((o) => o.cveIds.includes('CVE-2019-10744'));
    expect(known).toBeDefined();
    expect(known.componentVersion).toBe('4.17.4');
    expect(known.engineSeverity).toBe('CRITICAL');
    expect(known.cweIds).toContain('CWE-1321');
    expect(known.capabilityId).toBe('SCA');
  });

  it('normalizes real OSV-Scanner findings', () => {
    const observations = normalizeRaw('osv-scanner', load('osv-scanner.json'));
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.category === 'SCA' && o.component === 'lodash')).toBe(true);
    expect(observations.every((o) => o.cveIds.every((id) => id.startsWith('CVE-')))).toBe(true);
    expect(observations[0].location).toContain('package-lock.json');
    expect(observations[0].capabilityId).toBe('SCA');
  });

  it('normalizes a real Semgrep finding', () => {
    const [obs] = normalizeRaw('semgrep', load('semgrep.json'));
    expect(obs.category).toBe('SAST');
    expect(obs.ruleId).toBe('tmp.test-eval-detected');
    expect(obs.cweIds).toEqual(['CWE-95']);
    expect(obs.location).toMatch(/app\.js:7$/);
    expect(obs.capabilityId).toBe('SAST');
  });

  it('normalizes a Nuclei finding AND redacts Authorization/Set-Cookie from evidence', () => {
    const [obs] = normalizeRaw('nuclei', load('nuclei.json'));
    expect(obs.category).toBe('WEB');
    expect(obs.ruleId).toBe('bci-web-missing-hsts');
    expect(obs.evidence.request).not.toContain('super-secret-token');
    expect(obs.evidence.request).toContain('[REDACTED]');
    expect(obs.evidence.response).not.toContain('abc123');
    expect(obs.capabilityId).toBe('WEB');
  });

  it('normalizes a naabu open-port finding as NETWORK_DISCOVERY, not a vulnerability', () => {
    const [obs] = normalizeRaw('naabu', load('naabu.json'));
    expect(obs.category).toBe('NETWORK_DISCOVERY');
    expect(obs.location).toBe('127.0.0.1:40091');
    expect(obs.cveIds).toBeUndefined();
    expect(obs.capabilityId).toBe('NETWORK_DISCOVERY');
  });

  it('normalizes only real advanced-adapter anomalies with capability provenance', () => {
    const fuzz = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/api', parameter: 'q', location: 'query',
        category: 'INTEGER_NEGATIVE', source: 'BASE', status: 500, anomalous: true, anomalyReasons: ['server_error'],
      }],
    });
    const intrusive = normalizeRaw('intrusive-validation', {
      raw: [{
        type: 'INTRUSIVE_VALIDATION_RECORD', module: 'HTTP_METHOD_PROTOCOL', family: 'HTTP_METHOD_PROTOCOL',
        target: 'http://example.test', endpoint: 'http://example.test', testType: 'TRACE_METHOD_ACCEPTED', source: 'BASE',
        baseline: null, observed: { method: 'TRACE', status: 200 }, evidence: { method: 'TRACE', httpStatus: 200 },
        verificationStatus: 'VERIFIED', relatedFindingId: null, round: { number: 1 },
        anomalous: true, anomalyReasons: ['trace_method_accepted'],
      }],
    });
    const availability = normalizeRaw('availability-probe', {
      raw: [{
        type: 'RESILIENCE_ROUND', module: 'CAPACITY', family: 'CAPACITY', target: 'http://example.test',
        requestedPlan: { totalRequests: 100, concurrency: 10 }, executedPlan: { totalRequests: 100, concurrency: 10 }, clamps: [],
        metrics: { attempted: 100, completed: 90, errorRate: 0.1, timeoutRate: 0 }, degradation: { signal: 'SATURATED' },
        status: 'SATURATED', relatedFindingId: null, round: { number: 1 }, anomalous: true, anomalyReasons: ['capacity_saturated'],
      }],
    });
    expect(fuzz[0].capabilityId).toBe('FUZZ');
    expect(fuzz[0].evidence.source).toBe('BASE');
    expect(intrusive[0].capabilityId).toBe('INTRUSIVE');
    expect(availability[0].capabilityId).toBe('DOS');
    expect(normalizeRaw('http-fuzz', { raw: [{ type: 'HTTP_FUZZ_PROBE', anomalous: false, status: 200, anomalyReasons: [] }] })).toEqual([]);
  });

  it('BCI Smart Fuzz picks severity/rule/title by the actual anomaly reason, not a single generic bucket', () => {
    const reflected = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/search', parameter: 'q', location: 'query',
        category: 'XSS_MARKER', status: 200, anomalous: true, anomalyReasons: ['payload_reflected_unescaped'], reflected: true,
      }],
    });
    expect(reflected[0].engineSeverity).toBe('HIGH');
    expect(reflected[0].ruleId).toBe('BCI-HTTP-FUZZ-REFLECTED');

    const sizeDeviation = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/list', parameter: 'limit', location: 'query',
        category: 'INTEGER_LARGE', status: 200, anomalous: true, anomalyReasons: ['response_size_deviation'],
      }],
    });
    expect(sizeDeviation[0].engineSeverity).toBe('LOW');
    expect(sizeDeviation[0].ruleId).toBe('BCI-HTTP-FUZZ-SIZE-DEVIATION');

    // Discovered-but-not-executed (a mutating endpoint BCI stayed
    // SAFE_ACTIVE and refused to fuzz) must never itself become a finding.
    expect(normalizeRaw('http-fuzz', { raw: [{ type: 'HTTP_FUZZ_DISCOVERED_NOT_EXECUTED', method: 'POST', endpoint: 'http://example.test/submit' }] })).toEqual([]);
  });

  it('BASE and AI_ADAPTIVE probe provenance is kept distinct in the finding evidence, never merged', () => {
    const [baseFinding] = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/api', parameter: 'q', location: 'query',
        category: 'XSS_MARKER', source: 'BASE', status: 200, anomalous: true, anomalyReasons: ['payload_reflected_unescaped'],
      }],
    });
    const [adaptiveFinding] = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/api', parameter: 'q', location: 'query',
        category: 'INTEGER_OVERFLOW', source: 'AI_ADAPTIVE', status: 500, anomalous: true, anomalyReasons: ['server_error'],
      }],
    });
    const [userFinding] = normalizeRaw('http-fuzz', {
      raw: [{
        type: 'HTTP_FUZZ_PROBE', method: 'GET', endpoint: 'http://example.test/api', parameter: 'q', location: 'query',
        category: 'SQLI_MARKER', source: 'USER', status: 500, anomalous: true, anomalyReasons: ['server_error'],
      }],
    });
    expect(baseFinding.evidence.source).toBe('BASE');
    expect(baseFinding.description).toContain('base probe');
    expect(adaptiveFinding.evidence.source).toBe('AI_ADAPTIVE');
    expect(adaptiveFinding.description).toContain('AI-adaptive probe');
    expect(userFinding.evidence.source).toBe('USER');
    expect(userFinding.description).toContain('user-selected probe');
  });

  it('BCI Smart Intrusive never produces a finding from a record that is not both anomalous AND VERIFIED', () => {
    const record = (overrides) => ({
      type: 'INTRUSIVE_VALIDATION_RECORD', module: 'CORS_VALIDATION', family: 'CORS_VALIDATION',
      target: 'http://example.test', endpoint: 'http://example.test', testType: 'UNTRUSTED_ORIGIN_REFLECTION', source: 'BASE',
      baseline: null, observed: {}, evidence: {}, verificationStatus: 'VERIFIED', relatedFindingId: null, round: { number: 1 },
      anomalous: true, anomalyReasons: ['cors_permissive_origin'], ...overrides,
    });
    expect(normalizeIntrusiveValidation({ raw: [record({ verificationStatus: 'ERROR' })] })).toEqual([]);
    expect(normalizeIntrusiveValidation({ raw: [record({ verificationStatus: 'UNVERIFIED' })] })).toEqual([]);
    expect(normalizeIntrusiveValidation({ raw: [record({ verificationStatus: 'NOT_APPLICABLE' })] })).toEqual([]);
    expect(normalizeIntrusiveValidation({ raw: [record({ anomalous: false, anomalyReasons: [] })] })).toEqual([]);
    const [finding] = normalizeIntrusiveValidation({ raw: [record({})] });
    expect(finding.capabilityId).toBe('INTRUSIVE');
    expect(finding.evidence.module).toBe('CORS_VALIDATION');
    expect(finding.evidence.source).toBe('BASE');
    expect(finding.evidence.verificationStatus).toBe('VERIFIED');
  });

  it('BCI Smart Intrusive keeps BASE/USER/AI_ADAPTIVE provenance distinct and carries relatedFindingId through for reproducibility records', () => {
    const [userFinding] = normalizeIntrusiveValidation({
      raw: [{
        type: 'INTRUSIVE_VALIDATION_RECORD', module: 'HOST_ROUTING_VALIDATION', family: 'HOST_ROUTING_VALIDATION',
        target: 'http://example.test', endpoint: 'http://example.test', testType: 'BOGUS_HOST_HEADER_REFLECTION', source: 'USER',
        baseline: null, observed: {}, evidence: {}, verificationStatus: 'VERIFIED', relatedFindingId: null, round: { number: 1 },
        anomalous: true, anomalyReasons: ['host_header_reflected_in_redirect'],
      }],
    });
    expect(userFinding.evidence.source).toBe('USER');
    expect(userFinding.description).toContain('user-selected');

    const [reproFinding] = normalizeIntrusiveValidation({
      raw: [{
        type: 'INTRUSIVE_VALIDATION_RECORD', module: 'FINDING_REPRODUCIBILITY_VERIFICATION', family: 'FINDING_REPRODUCIBILITY_VERIFICATION',
        target: 'http://example.test', endpoint: 'http://example.test/search', testType: 'REPRODUCE_PRIOR_FINDING', source: 'AI_ADAPTIVE',
        baseline: { originalStatus: 200 }, observed: { status: 200 }, evidence: { findingId: 'f1' },
        verificationStatus: 'VERIFIED', relatedFindingId: 'f1', round: { number: 2 },
        anomalous: true, anomalyReasons: ['prior_finding_reproduced'],
      }],
    });
    expect(reproFinding.evidence.relatedFindingId).toBe('f1');
    expect(reproFinding.evidence.roundNumber).toBe(2);
    expect(reproFinding.description).toContain('round 2');
  });

  it('BCI Smart Resilience only produces a finding from a round that is both anomalous AND has no execution error, with a real measurement-derived status', () => {
    const round = (overrides) => ({
      type: 'RESILIENCE_ROUND', module: 'CAPACITY', family: 'CAPACITY', target: 'http://example.test',
      requestedPlan: { totalRequests: 200, concurrency: 20 }, executedPlan: { totalRequests: 200, concurrency: 20 }, clamps: [],
      metrics: { attempted: 200, completed: 150 }, degradation: { signal: 'SATURATED' }, source: 'BASE',
      status: 'SATURATED', relatedFindingId: null, round: { number: 1 }, anomalous: true, anomalyReasons: ['capacity_saturated'],
      ...overrides,
    });
    // INCONCLUSIVE is a real, non-anomalous status -- never a finding.
    expect(normalizeAvailabilityProbe({ raw: [round({ status: 'INCONCLUSIVE', anomalous: false })] })).toEqual([]);
    // A real execution error (module couldn't run) never becomes a "confirmed" finding either.
    expect(normalizeAvailabilityProbe({ raw: [round({ error: 'connection refused' })] })).toEqual([]);
    // STABLE/RECOVERED are real, healthy outcomes -- never findings.
    expect(normalizeAvailabilityProbe({ raw: [round({ status: 'STABLE', anomalous: false })] })).toEqual([]);

    const [finding] = normalizeAvailabilityProbe({ raw: [round({})] });
    expect(finding.capabilityId).toBe('DOS');
    expect(finding.evidence.status).toBe('SATURATED');
    expect(finding.evidence.source).toBe('BASE');
    expect(finding.evidence.requestedPlan.totalRequests).toBe(200);
    expect(finding.evidence.executedPlan.totalRequests).toBe(200);
  });

  it('BCI Smart Resilience keeps BASE/USER/AI_ADAPTIVE round provenance distinct', () => {
    const [userFinding] = normalizeAvailabilityProbe({
      raw: [{
        type: 'RESILIENCE_ROUND', module: 'RECOVERY', family: 'RECOVERY', target: 'http://example.test',
        requestedPlan: {}, executedPlan: {}, clamps: [], metrics: { attempted: 10, completed: 10 }, degradation: null,
        status: 'RECOVERY_FAILED', relatedFindingId: null, round: { number: 1 }, anomalous: true, anomalyReasons: ['did_not_recover_after_load'], source: 'USER',
      }],
    });
    expect(userFinding.evidence.source).toBe('USER');
    expect(userFinding.description).toContain('user-selected');

    const [aiFinding] = normalizeAvailabilityProbe({
      raw: [{
        type: 'RESILIENCE_ROUND', module: 'RATE_LIMIT', family: 'RATE_LIMIT', target: 'http://example.test',
        requestedPlan: {}, executedPlan: {}, clamps: [], metrics: { attempted: 10, completed: 10, rateLimitedCount: 8 }, degradation: null,
        status: 'RATE_LIMITED', relatedFindingId: null, round: { number: 2 }, anomalous: true, anomalyReasons: ['rate_limit_triggered'], source: 'AI_ADAPTIVE',
      }],
    });
    expect(aiFinding.evidence.source).toBe('AI_ADAPTIVE');
    expect(aiFinding.description).toContain('AI-adaptive');
    expect(aiFinding.description).toContain('round 2');
  });
});
