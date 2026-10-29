import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mail;
const fetchMock = vi.fn();
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('RESEND_API_KEY', 're_TEST_ONLY');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  mail = await import('./email.js');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('mail submission contract', () => {
  it('requires an accepted message ID', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await expect(mail.sendEmergencyAlert('TEST', 'test')).rejects.toThrow();
  });
  it('rejects permanent provider errors without retrying', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { name: 'validation_error', message: 'denied' }));
    await expect(mail.sendApprovalEmail('TEST', 'https://example.invalid', 'https://example.invalid')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['rate_limit_exceeded', 'internal_server_error', 'application_error'])('retries %s with the same idempotency key', async (name) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(500, { name, message: 'temporary' }))
      .mockResolvedValueOnce(reply(200, { id: 'accepted' }));
    const pending = mail.sendSfreReportEmail({ subject: 'test', text: 'test' });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ data: { id: 'accepted' } });
    const keys = fetchMock.mock.calls.map(([, options]) => options.headers.get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });
  it('rejects a partially failed broadcast after attempting each recipient', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 'accepted' }))
      .mockResolvedValueOnce(reply(403, { name: 'validation_error', message: 'denied' }));
    await expect(mail.sendEmergencyBroadcastEmail('TEST', 'test', [
      { email: 'one@example.invalid' }, { email: 'two@example.invalid' },
    ])).rejects.toBeInstanceOf(AggregateError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('fails explicitly when the API key is absent', async () => {
    vi.stubEnv('RESEND_API_KEY', ''); vi.resetModules();
    const disabled = await import('./email.js');
    await expect(disabled.sendSfreReportEmail({ subject: 'test' })).rejects.toThrow('yapılandırılmamış');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
