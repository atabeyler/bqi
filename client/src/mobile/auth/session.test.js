import { describe, it, expect, vi } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { dbGet } from '../db/index.js';
import { createSessionManager } from './session.js';

function fakeJwt(payload) {
  const b64 = btoa(JSON.stringify(payload));
  return `header.${b64}.signature`;
}

function memoryStore() {
  let value = null;
  return { save: async (v) => { value = v; }, load: async () => value, clear: async () => { value = null; } };
}

const DEVICE = 'BQI-AND-AAAAAAAA';

async function buildManager({ fetchImpl }) {
  const db = await createTestMobileDb();
  const secureStore = memoryStore();
  const manager = createSessionManager({ db, secureStore, deviceId: DEVICE, apiBaseUrl: 'https://api.test', fetchImpl, appVersion: '1.0.0' });
  return { db, manager, secureStore };
}

describe('establishOnlineSession', () => {
  it('registers the device with the server and caches the session locally', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });

    const jwt = fakeJwt({ userCode: 'BOLD-001', nickname: 'Ali' });
    const result = await manager.establishOnlineSession(jwt);

    expect(result.userCode).toBe('BOLD-001');
    expect((await secureStore.load()).jwt).toBe(jwt);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/api/devices/register',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('unlocks offline login for that account on this device afterward', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    expect(await manager.isOfflineLoginAllowed('BOLD-001')).toBe(true);
    expect(await manager.isOfflineLoginAllowed('BOLD-002')).toBe(false);
  });

  it('does not cache the session if server-side device registration fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Cihaz limiti aşıldı' }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });

    await expect(manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }))).rejects.toThrow('Cihaz limiti aşıldı');
    expect(await secureStore.load()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure right after login instead of permanently stranding the device offline', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = await buildManager({ fetchImpl });

    const resultPromise = manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.userCode).toBe('BOLD-001');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await secureStore.load()).userCode).toBe('BOLD-001');
    vi.useRealTimers();
  });

  it('gives up and rejects after repeated registration failures, still without caching anything', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const { manager, secureStore } = await buildManager({ fetchImpl });

    const resultPromise = manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    const assertion = expect(resultPromise).rejects.toThrow('Failed to fetch');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await secureStore.load()).toBeNull();
    vi.useRealTimers();
  });
});

describe('verifyOfflineLogin (spec: hashed, never plaintext)', () => {
  it('accepts the correct password for a previously online-authorized account', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(true);
    expect(result.jwt).toBeTruthy();
  });

  it('rejects a wrong password', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    expect((await manager.verifyOfflineLogin('BOLD-001', 'WrongPassword')).ok).toBe(false);
  });

  it('rejects offline login for a device never authorized for that account', async () => {
    const { manager } = await buildManager({ fetchImpl: vi.fn() });
    expect((await manager.verifyOfflineLogin('BOLD-001', 'whatever')).ok).toBe(false);
  });

  it('never stores the plaintext password anywhere in the cached session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    const stored = JSON.stringify(await secureStore.load());
    expect(stored).not.toContain('CorrectHorse123');
    expect((await secureStore.load()).offlinePasswordHash).toMatch(/^\$2[aby]\$/);
  });
});

describe('getSession', () => {
  it('never exposes the password hash to the caller', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    expect((await manager.getSession()).offlinePasswordHash).toBeUndefined();
  });

  it('still returns the cached session even past JWT expiry (local SQLite access stays available offline)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });

    await manager.establishOnlineSession(expiredJwt);
    expect((await manager.getSession()).userCode).toBe('BOLD-001');
  });
});

describe('needsReauth', () => {
  it('is false with no cached session at all', async () => {
    const { manager } = await buildManager({ fetchImpl: vi.fn() });
    expect(await manager.needsReauth()).toBe(false);
  });

  it('is false right after a normal online login (fresh, non-expired JWT)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });

    await manager.establishOnlineSession(freshJwt);
    expect(await manager.needsReauth()).toBe(false);
  });

  it('is true once the cached JWT\'s exp claim has passed (e.g. after a long offline stretch)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });

    await manager.establishOnlineSession(expiredJwt);
    expect(await manager.needsReauth()).toBe(true);
  });

  it('goes back to false once a fresh online login replaces the expired cached session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });
    await manager.establishOnlineSession(expiredJwt);
    expect(await manager.needsReauth()).toBe(true);

    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });
    await manager.establishOnlineSession(freshJwt);
    expect(await manager.needsReauth()).toBe(false);
  });
});

describe('logoutSession', () => {
  it('preserves the cached jwt, marks the session signed-out, and leaves offline-login authorization intact', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });

    const jwt = fakeJwt({ userCode: 'BOLD-001' });
    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    await manager.logoutSession();

    expect((await secureStore.load()).jwt).toBe(jwt);
    expect((await secureStore.load()).signedOut).toBe(true);
    expect(await manager.getSession()).toBeNull();
    expect(await manager.isOfflineLoginAllowed('BOLD-001')).toBe(true);
  });

  it('offline login with the same password still succeeds afterward, returning a non-null jwt and clearing signedOut', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    await manager.logoutSession();

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(true);
    expect(result.jwt).toBeTruthy();
    expect((await secureStore.load()).signedOut).toBe(false);
  });

  it('is a no-op and does not throw when there is no cached session at all', async () => {
    const { manager } = await buildManager({ fetchImpl: vi.fn() });
    await expect(manager.logoutSession()).resolves.toBeUndefined();
    expect(await manager.getSession()).toBeNull();
  });
});

describe('forgetDevice', () => {
  it('revokes offline-login authorization and exposes no active session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    await manager.forgetDevice();

    expect(await manager.getSession()).toBeNull();
    expect(await manager.isOfflineLoginAllowed('BOLD-001')).toBe(false);
  });

  it('subsequent offline login fails with device_not_authorized_offline', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    await manager.forgetDevice();

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('device_not_authorized_offline');
  });

  it('fires a best-effort DELETE using the previously-cached jwt when network is allowed', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = await buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt);
    fetchImpl.mockClear();
    await manager.forgetDevice();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/devices/${DEVICE}`,
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: `Bearer ${jwt}` }) })
    );
  });

  it('keeps only a non-sensitive secure tombstone if the immediate DELETE fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    fetchImpl.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(manager.forgetDevice()).resolves.toEqual({ pendingServerRevoke: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await secureStore.load();
    expect(stored).toEqual({ signedOut: true, pendingServerRevoke: { deviceId: DEVICE, userCode: 'BOLD-001' } });
    expect(JSON.stringify(stored)).not.toContain(jwt);
    expect(JSON.stringify(stored)).not.toContain('CorrectHorse123');
    expect(await manager.getSession()).toBeNull();
  });

  it('allowNetwork:false never exports the cached jwt and stores only deviceId in secureStore', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = await buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    fetchImpl.mockClear();
    const result = await manager.forgetDevice({ allowNetwork: false });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ pendingServerRevoke: null });
    expect(await secureStore.load()).toEqual({ signedOut: true, pendingServerRevoke: { deviceId: DEVICE, userCode: 'BOLD-001' } });
    expect(JSON.stringify(await secureStore.load())).not.toContain(jwt);
    expect(await manager.isOfflineLoginAllowed('BOLD-001')).toBe(false);
  });

  it('uses the next fresh online JWT to settle a pending revoke before re-registering the device', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = await buildManager({ fetchImpl });
    const oldJwt = fakeJwt({ userCode: 'BOLD-001' });
    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });

    await manager.establishOnlineSession(oldJwt, 'CorrectHorse123');
    await manager.forgetDevice({ allowNetwork: false });
    fetchImpl.mockClear();
    calls.length = 0;

    await manager.establishOnlineSession(freshJwt, 'CorrectHorse123');

    expect(calls[0].url).toBe(`https://api.test/api/devices/${DEVICE}`);
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${freshJwt}`);
    expect(calls[1].url).toBe('https://api.test/api/devices/register');
    expect((await secureStore.load()).jwt).toBe(freshJwt);
    expect((await secureStore.load()).pendingServerRevoke).toBeUndefined();
  });


  it('never uses a different account JWT to settle an older account pending revoke', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = await buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'PasswordA');
    await manager.forgetDevice({ allowNetwork: false });
    fetchImpl.mockClear();
    calls.length = 0;

    const userBJwt = fakeJwt({ userCode: 'BOLD-002', exp: Math.floor(Date.now() / 1000) + 3600 });
    await manager.establishOnlineSession(userBJwt, 'PasswordB');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test/api/devices/register');
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${userBJwt}`);
    expect((await secureStore.load()).userCode).toBe('BOLD-002');
    expect((await secureStore.load()).pendingServerRevoke).toBeUndefined();
  });
  it('resets failed_offline_attempts and offline_locked_until in device_meta', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, db } = await buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    for (let i = 0; i < 5; i += 1) {
      await manager.verifyOfflineLogin('BOLD-001', 'WrongPassword');
    }
    const lockedMeta = await dbGet(db, 'SELECT failed_offline_attempts, offline_locked_until FROM device_meta WHERE device_id = ?', [DEVICE]);
    expect(lockedMeta.failed_offline_attempts).toBeGreaterThan(0);
    expect(lockedMeta.offline_locked_until).toBeTruthy();

    await manager.forgetDevice();

    const meta = await dbGet(db, 'SELECT failed_offline_attempts, offline_locked_until FROM device_meta WHERE device_id = ?', [DEVICE]);
    expect(meta.failed_offline_attempts).toBe(0);
    expect(meta.offline_locked_until).toBeNull();
  });
});
