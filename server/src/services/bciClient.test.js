import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

describe('BCI gateway client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shares one first-login gateway session across concurrent dashboard calls', async () => {
    vi.stubEnv('BCI_BASE_URL', 'https://bci.internal');
    vi.stubEnv('BCI_GATEWAY_SECRET', 'test-gateway-secret-with-enough-entropy');

    let gatewayCalls = 0;
    let gatewayRole;
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/api/v1/gateway/session')) {
        gatewayCalls += 1;
        gatewayRole = jwt.decode(options.headers.authorization.slice('Bearer '.length)).role;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, json: async () => ({ token: 'bci-token' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { callBci } = await import('./bciClient.js');
    const user = { userCode: 'dashboard-user', role: 'admin' };
    const results = await Promise.all([
      '/api/v1/risk/security-score', '/api/v1/risk/coverage-score', '/api/v1/assets',
      '/api/v1/findings', '/api/v1/scans', '/api/v1/engines',
    ].map((path) => callBci(user, path)));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(gatewayCalls).toBe(1);
    expect(gatewayRole).toBe('system_admin');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
