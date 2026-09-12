import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildValidationToken, classifyAnalysisResult, generateProofId, normalizeProofTarget, sha256 } from '../src/controlledProof/core.js';
import { responseReflectionValidator } from '../src/controlledProof/validators/responseReflection.js';
import { resolveCandidatesFromObservations } from '../src/controlledProof/candidateResolver.js';
import { isSafeCanonicalRedirect } from '../src/controlledProof/targetResolver.js';
import { buildCloudflareWorkerSource, cloudflareEdgePublicVisibility, cloudflareRoutePattern } from '../src/controlledProof/publicVisibility/cloudflareEdge.js';
import { classifyPublicVisibilityProviders } from '../src/controlledProof/publicVisibility/providerDiscovery.js';
import { assertPublicVisibilityProvider } from '../src/controlledProof/publicVisibility/providerContract.js';
import { PUBLIC_VISIBILITY_SUPPORT } from '../src/controlledProof/publicVisibility/supportCatalog.js';
import { config } from '../src/config.js';
import { isCurlCertificateTrustError, secureNodeTlsFetch } from '../src/engines/adapters/nativeHttp.js';

let server;
let origin;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/reflect') {
      const marker = url.searchParams.get('q') || '';
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<main>${marker}</main>\nAuthorization: Bearer should-never-be-evidence`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<main>No reflection</main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => new Promise((resolve) => server.close(resolve)));

describe('Controlled Proof core safety', () => {
  it('normalizes only credential-free HTTP(S) targets', () => {
    expect(normalizeProofTarget('https://example.com/path#fragment')).toBe('https://example.com/path');
    expect(() => normalizeProofTarget('file:///tmp/x')).toThrow('invalid_target');
    expect(() => normalizeProofTarget('https://user:pass@example.com')).toThrow('invalid_target');
  });

  it('generates strong execution-specific proof ids and fixed tokens', () => {
    const first = generateProofId();
    const second = generateProofId();
    expect(first).toMatch(/^[A-F0-9]{32}$/);
    expect(second).not.toBe(first);
    expect(buildValidationToken(first, new Date('2026-09-09T19:22:16Z'))).toBe(`BCI VALIDATION · ${first} · 19:22:16`);
  });

  it('accepts only same-site, non-downgrade canonical redirects', () => {
    expect(isSafeCanonicalRedirect(new URL('https://example.com/'), new URL('https://www.example.com/'))).toBe(true);
    expect(isSafeCanonicalRedirect(new URL('https://example.com/'), new URL('http://example.com/'))).toBe(false);
    expect(isSafeCanonicalRedirect(new URL('https://example.com/'), new URL('https://evil.example/'))).toBe(false);
    expect(isSafeCanonicalRedirect(new URL('https://example.com/'), new URL('https://example.com:8443/'))).toBe(false);
  });

  it('resolves real engine evidence into validator candidates and explains unsupported evidence', () => {
    const targetUrls = [new URL('https://www.example.com/')];
    const resolved = resolveCandidatesFromObservations([
      { id: 'o1', engine_id: 'http-fuzz', target: 'https://example.com', location: 'query:q', finding_id: 'f1', rule_id: 'BCI-HTTP-FUZZ-REFLECTED', evidence: { endpoint: 'https://example.com/search', parameter: 'q', location: 'query', reflected: true, anomalyReasons: ['payload_reflected_unescaped'] } },
      { id: 'o2', engine_id: 'nuclei', target: 'https://example.com', location: 'https://example.com/admin', finding_id: 'f2', rule_id: 'reflected-xss', title: 'Reflected XSS check', category: 'WEB', engine_severity: 'high', verification_status: 'CONFIRMED', evidence: {} },
    ], targetUrls);
    expect(resolved.candidates).toEqual([expect.objectContaining({ engineId: 'http-fuzz', findingId: 'f1', parameter: 'q' })]);
    expect(resolved.rejections).toEqual([expect.objectContaining({ engineId: 'nuclei', reason: 'NO_COMPATIBLE_RESPONSE_VALIDATOR' })]);
    expect(resolved.rejectionSummary).toEqual([{ engineId: 'nuclei', reason: 'NO_COMPATIBLE_RESPONSE_VALIDATOR', count: 1 }]);
    expect(resolved.observationSummaries).toContainEqual(expect.objectContaining({
      engineId: 'nuclei', ruleId: 'reflected-xss', title: 'Reflected XSS check', category: 'WEB',
      severity: 'high', location: 'https://example.com/admin', verificationStatus: 'CONFIRMED',
      contentImpactSignal: true, proofEligibility: 'NO_COMPATIBLE_RESPONSE_VALIDATOR',
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('adds technology-aware finding evidence guidance without upgrading proof verification', () => {
    const resolved = resolveCandidatesFromObservations([{
      id: 'header-1', engine_id: 'nuclei', target: 'https://example.com', location: 'https://example.com/',
      rule_id: 'bci-web-missing-hsts', title: 'Missing HSTS', engine_severity: 'info',
      verification_status: 'OBSERVED', evidence: { response: 'HTTP/1.1 200 OK\r\nServer: Microsoft-IIS/10.0\r\n' },
    }], [new URL('https://example.com/')], { providerIds: ['microsoft-iis'] });
    expect(resolved.observationSummaries[0]).toMatchObject({
      technology: 'Microsoft IIS', verificationStatus: 'OBSERVED', proofEligibility: 'NOT_WEB_CONTENT_IMPACT_SIGNAL',
    });
    expect(resolved.observationSummaries[0].technicalEvidence).toContain('Strict-Transport-Security');
    expect(resolved.observationSummaries[0].remediation).toContain('IIS');
    expect(resolved.observationSummaries[0].revalidation).toContain('fresh header check');
  });

  it('does not classify a probe candidate as potential without a real impact signal', () => {
    expect(classifyAnalysisResult({ hasPotentialSignals: false })).toBe('NO_PATH');
    expect(classifyAnalysisResult({ hasPotentialSignals: true })).toBe('POTENTIAL');
    expect(classifyAnalysisResult({ verified: true })).toBe('VERIFIED_IMPACT_PATH');
  });

  it('recognizes curl trust-store errors and uses a verified GET-only TLS fallback contract', async () => {
    expect(isCurlCertificateTrustError(new Error('curl exited 60: SSL certificate problem: unable to get local issuer certificate'))).toBe(true);
    expect(isCurlCertificateTrustError(new Error('curl exited 28: timed out'))).toBe(false);
    const response = await secureNodeTlsFetch(`${origin}/plain`, { headers: ['Accept: text/html'] });
    expect(response).toMatchObject({ status: 200, transport: 'node-aia-verified-tls-fallback' });
    expect(response.body).toContain('No reflection');
    await expect(secureNodeTlsFetch(`${origin}/plain`, { method: 'POST' })).rejects.toThrow('supports only GET and HEAD');
  });

  it('summarizes all candidate rejections without the detailed-evidence display cap changing totals', () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `o${index}`, engine_id: index < 60 ? 'http-fuzz' : 'naabu', target: 'https://example.com',
      location: '/', evidence: {},
    }));
    const resolved = resolveCandidatesFromObservations(rows, [new URL('https://example.com/')]);
    expect(resolved.rejections).toHaveLength(75);
    expect(resolved.rejectionSummary).toEqual(expect.arrayContaining([
      { engineId: 'http-fuzz', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL', count: 60 },
      { engineId: 'naabu', reason: 'NOT_WEB_CONTENT_IMPACT_SIGNAL', count: 15 },
    ]));
  });

  it('builds a homepage-only public marker worker with an absolute self-expiry', () => {
    const marker = buildValidationToken(generateProofId(), new Date('2026-09-10T10:00:00Z'));
    const expiresAt = new Date('2026-09-10T10:00:30Z');
    const source = buildCloudflareWorkerSource({ marker, target: 'https://www.example.com/', expiresAt });
    expect(cloudflareRoutePattern('https://www.example.com/')).toBe('www.example.com/');
    expect(source).toContain(String(expiresAt.getTime()));
    expect(source).toContain(marker);
    expect(source).toContain('url.pathname !== "/"');
    expect(source).toContain("cache-control', 'private, no-store, max-age=0");
    expect(source).not.toContain('eval(');
  });

  it('allows public visibility only for an explicitly configured HTTPS homepage', () => {
    const previousToken = config.controlledProof.cloudflareApiToken;
    const previousTargets = config.controlledProof.cloudflareTargets;
    config.controlledProof.cloudflareApiToken = 'test-token-limited';
    config.controlledProof.cloudflareTargets = { 'www.example.com': { accountId: 'account_12345678', zoneId: 'zone_12345678' } };
    try {
      expect(cloudflareEdgePublicVisibility.capability('https://www.example.com/').available).toBe(true);
      expect(cloudflareEdgePublicVisibility.capability('https://www.example.com/path').available).toBe(false);
      expect(cloudflareEdgePublicVisibility.capability('http://www.example.com/').available).toBe(false);
      expect(cloudflareEdgePublicVisibility.capability('https://other.example.com/').available).toBe(false);
    } finally {
      config.controlledProof.cloudflareApiToken = previousToken;
      config.controlledProof.cloudflareTargets = previousTargets;
    }
  });

  it('reports delivery-provider evidence separately from adapter availability', () => {
    const candidates = classifyPublicVisibilityProviders({
      hostname: 'www.example.com',
      nameservers: ['ns6.wixdns.net'],
      responseHeaders: { server: 'cloudflare', 'cf-ray': 'redacted', 'x-wix-request-id': 'redacted', link: 'https://static.parastorage.com' },
    });
    expect(candidates[0]).toMatchObject({
      providerId: 'wix', adapterId: null, adapterStatus: 'BLOCKED',
      blockingReason: 'response_body_transform_requires_site_deployment', confidence: 'HIGH',
    });
    expect(candidates).toContainEqual(expect.objectContaining({ providerId: 'cloudflare', adapterId: 'cloudflare-edge-worker' }));
    expect(JSON.stringify(candidates)).not.toContain('redacted');
  });

  it('reports common origin server technology even when no public adapter exists', () => {
    const candidates = classifyPublicVisibilityProviders({
      responseHeaders: { server: 'Microsoft-IIS/10.0', 'x-powered-by': 'ASP.NET' },
    });
    expect(candidates[0]).toMatchObject({
      providerId: 'microsoft-iis', adapterId: null, adapterStatus: 'BLOCKED',
      blockingReason: 'origin_change_has_no_safe_self_expiry', confidence: 'MEDIUM',
    });
  });

  it('classifies managed hosting, CMS, ingress, and CDN technologies without claiming an adapter', () => {
    const candidates = classifyPublicVisibilityProviders({
      cnames: ['customer.vercel.app', 'origin.amplifyapp.com'],
      responseHeaders: {
        'x-nf-request-id': 'request-id',
        'x-generator': 'WordPress',
        server: 'ingress-nginx',
      },
    });
    for (const providerId of ['vercel', 'aws-amplify', 'netlify', 'wordpress', 'kubernetes-ingress']) {
      expect(candidates).toContainEqual(expect.objectContaining({ providerId, adapterId: null, adapterStatus: 'BLOCKED' }));
    }
    expect(candidates.every((candidate) => candidate.blockingReason)).toBe(true);
  });

  it('publishes an explicit no-fake support decision for every requested platform family', () => {
    const ids = new Set(PUBLIC_VISIBILITY_SUPPORT.map((item) => item.id));
    for (const id of [
      'cloudflare', 'aws-cloudfront', 'fastly', 'akamai', 'azure-front-door', 'google-cloud',
      'vercel', 'netlify', 'aws-amplify', 'azure-static-web-apps', 'microsoft-iis', 'nginx',
      'apache-httpd', 'kubernetes-ingress', 'wordpress', 'drupal', 'wix', 'unknown-custom',
    ]) expect(ids.has(id)).toBe(true);
    expect(PUBLIC_VISIBILITY_SUPPORT.filter((item) => item.adapterStatus === 'IMPLEMENTED'))
      .toEqual([expect.objectContaining({ id: 'cloudflare', adapterId: 'cloudflare-edge-worker' })]);
    expect(PUBLIC_VISIBILITY_SUPPORT.filter((item) => item.adapterStatus !== 'IMPLEMENTED').every((item) => item.blockingReason)).toBe(true);
  });

  it('rejects incomplete provider adapters before they enter the production registry', () => {
    expect(() => assertPublicVisibilityProvider({ id: 'test-provider', infrastructureProvider: 'test', capability() {} }))
      .toThrow('invalid_public_visibility_provider_method:test-provider:activate');
  });

  it('activates, publicly observes, and removes a real provider resource flow without persisting its token', async () => {
    const previousToken = config.controlledProof.cloudflareApiToken;
    const previousTargets = config.controlledProof.cloudflareTargets;
    const marker = buildValidationToken(generateProofId());
    let routeRemoved = false;
    const providerFetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith('https://api.cloudflare.com/')) {
        if (init.method === 'DELETE' && url.includes('/workers/routes/')) routeRemoved = true;
        const result = init.method === 'POST' && url.endsWith('/workers/routes') ? { id: 'route_12345678' } : [];
        return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(routeRemoved ? '<html><body>origin</body></html>' : `<html><body>${marker}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    config.controlledProof.cloudflareApiToken = 'provider-secret-token';
    config.controlledProof.cloudflareTargets = { 'www.example.com': { accountId: 'account_12345678', zoneId: 'zone_12345678' } };
    vi.stubGlobal('fetch', providerFetch);
    try {
      const activation = await cloudflareEdgePublicVisibility.activate({ target: 'https://www.example.com/', marker, proofId: 'A'.repeat(32), durationSeconds: 5 });
      expect(activation.observations).toHaveLength(2);
      expect(activation.observations.every((item) => item.visible)).toBe(true);
      expect(JSON.stringify(activation)).not.toContain('provider-secret-token');
      const expiry = await cloudflareEdgePublicVisibility.expire({ target: 'https://www.example.com/', marker, resources: activation.resources });
      expect(expiry.removed).toBe(true);
      expect(providerFetch.mock.calls.some(([, init]) => init?.headers?.Authorization === 'Bearer provider-secret-token')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      config.controlledProof.cloudflareApiToken = previousToken;
      config.controlledProof.cloudflareTargets = previousTargets;
    }
  });
});

describe('Security Impact Validation', () => {
  it('verifies a real reflected response but persists no raw response, marker, or secret', async () => {
    const marker = buildValidationToken(generateProofId());
    const result = await responseReflectionValidator.validate({ candidate: { endpoint: `${origin}/reflect`, parameter: 'q' }, marker });
    expect(result.verified).toBe(true);
    expect(result.evidence.response.markerHash).toBe(sha256(marker));
    expect(JSON.stringify(result.evidence)).not.toContain('should-never-be-evidence');
    expect(JSON.stringify(result.evidence)).not.toContain(marker);
  });

  it('does not guess impact when the marker is absent', async () => {
    const marker = buildValidationToken(generateProofId());
    const result = await responseReflectionValidator.validate({ candidate: { endpoint: `${origin}/plain`, parameter: 'q' }, marker });
    expect(result.verified).toBe(false);
  });
});
