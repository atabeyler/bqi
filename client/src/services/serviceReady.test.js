import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForService } from './serviceReady.js';
import { api } from './api.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const ready = () => ({ ok: true, status: 200, json: async () => ({ status: 'OK' }) });

describe('cold service startup', () => {
  it('waits through a loading HTML response and DB startup before sending credentials once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new SyntaxError('HTML'); } })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ status: 'NOT_READY' }) })
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'approval' }) });
    vi.stubGlobal('fetch', fetchMock);
    const pending = api.loginRequest('U1', 'test-password');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ token: 'approval' });
    expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    for (const [url, options] of fetchMock.mock.calls.slice(0, 3)) {
      expect(url).toContain('/api/health/ready');
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit' });
      expect(options.body).toBeUndefined();
    }
  });
  it('does not replay a failed login', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ready()).mockRejectedValueOnce(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.loginRequest('U1', 'test')).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('bounds startup and never sends credentials while the DB is unavailable', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ status: 'NOT_READY' }) }));
    const pending = waitForService('/health', { fetchImpl: fetchMock, timeoutMs: 3100, pollMs: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'SERVICE_NOT_READY' });
    await vi.runAllTimersAsync(); await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it('preserves a genuine network failure for native offline login', async () => {
    await expect(waitForService('/health', { fetchImpl: async () => { throw new TypeError('offline'); } })).rejects.toBeInstanceOf(TypeError);
  });
  it('does not poll a misconfigured readiness address', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) }));
    await expect(waitForService('/health', { fetchImpl: fetchMock })).rejects.toMatchObject({ code: 'SERVICE_NOT_READY' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
