import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('waits for BCI DB readiness and submits the login exactly once', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ database: 'down' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'ok', database: 'up' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'test' }) });
  vi.stubGlobal('fetch', fetchMock);
  const pending = api.login('test-org', 'test@example.invalid', 'test-password');
  await vi.runAllTimersAsync();
  expect(await pending).toEqual({ token: 'test' });
  expect(fetchMock.mock.calls.slice(0, 2).every(([url, options]) => url.endsWith('/health/ready') && options.method === 'GET' && !options.body)).toBe(true);
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
});
