import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { createSessionManager } from './session.js';

function fakeJwt(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `header.${b64}.signature`;
}

function memoryStore() {
  let value = null;
  return {
    save: (v) => { value = v; return { persisted: true }; },
    load: () => value,
    clear: () => { value = null; },
    encryptionAvailable: () => true,
  };
}

const DEVICE = 'BQI-WIN-AAAAAAAA';

function buildManager({ fetchImpl }) {
  const db = createTestDb();
  const secureStore = memoryStore();
  const manager = createSessionManager({ db, secureStore, deviceId: DEVICE, apiBaseUrl: 'https://api.test', fetchImpl, appVersion: '1.0.0' });
  return { db, manager, secureStore };
}

describe('establishOnlineSession', () => {
  it('registers the device with the server and caches the session locally', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });

    const jwt = fakeJwt({ userCode: 'BOLD-001', nickname: 'Ali' });
    const result = await manager.establishOnlineSession(jwt);

    expect(result.userCode).toBe('BOLD-001');
    expect(secureStore.load().jwt).toBe(jwt);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/api/devices/register',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('unlocks offline login for that account on this device afterward', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    expect(manager.isOfflineLoginAllowed('BOLD-001')).toBe(true);
    expect(manager.isOfflineLoginAllowed('BOLD-002')).toBe(false);
  });

  it('does not cache the session if server-side device registration fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Cihaz limiti aşıldı' }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });

    await expect(manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }))).rejects.toThrow('Cihaz limiti aşıldı');
    expect(secureStore.load()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure right after login instead of permanently stranding the device offline', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = buildManager({ fetchImpl });

    const resultPromise = manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.userCode).toBe('BOLD-001');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(secureStore.load().userCode).toBe('BOLD-001');
    vi.useRealTimers();
  });

  it('gives up and rejects after repeated registration failures, still without caching anything', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const { manager, secureStore } = buildManager({ fetchImpl });

    const resultPromise = manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    const assertion = expect(resultPromise).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(secureStore.load()).toBeNull();
    vi.useRealTimers();
  });
});

describe('establishOnlineSession when no OS keychain is available', () => {
  it('surfaces sessionPersisted:false instead of silently persisting an unencrypted session', async () => {
    const db = createTestDb();
    const secureStore = {
      save: () => ({ persisted: false }),
      load: () => null,
      clear: () => {},
      encryptionAvailable: () => false,
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const manager = createSessionManager({ db, secureStore, deviceId: DEVICE, apiBaseUrl: 'https://api.test', fetchImpl, appVersion: '1.0.0' });

    const result = await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    expect(result.sessionPersisted).toBe(false);
  });
});

describe('offline login gate (spec test I)', () => {
  it('a device that was never authorized online cannot offline-login', () => {
    const { manager } = buildManager({ fetchImpl: vi.fn() });
    expect(manager.isOfflineLoginAllowed('BOLD-001')).toBe(false);
  });

  it('getSession still returns the cached session even past JWT expiry (local SQLite access stays available offline)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });

    await manager.establishOnlineSession(expiredJwt);
    expect(manager.getSession().userCode).toBe('BOLD-001');
  });
});

describe('verifyOfflineLogin (spec: hashed, never plaintext)', () => {
  it('accepts the correct password for a previously online-authorized account', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(true);
    expect(result.jwt).toBeTruthy();
  });

  it('rejects a wrong password', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    const result = await manager.verifyOfflineLogin('BOLD-001', 'WrongPassword');
    expect(result.ok).toBe(false);
  });

  it('rejects offline login for a device never authorized for that account', async () => {
    const { manager } = buildManager({ fetchImpl: vi.fn() });
    const result = await manager.verifyOfflineLogin('BOLD-001', 'whatever');
    expect(result.ok).toBe(false);
  });

  it('never stores the plaintext password anywhere in the cached session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    const stored = JSON.stringify(secureStore.load());
    expect(stored).not.toContain('CorrectHorse123');
    expect(secureStore.load().offlinePasswordHash).toMatch(/^\$2[aby]\$/);
  });

  it('getSession() never exposes the password hash to the caller (the renderer, via IPC)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');

    expect(manager.getSession().offlinePasswordHash).toBeUndefined();
  });

  it('rejects offline login after forgetDevice, even with the correct password', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    manager.forgetDevice();

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('device_not_authorized_offline');
  });
});

describe('needsReauth', () => {
  it('is false with no cached session at all', () => {
    const { manager } = buildManager({ fetchImpl: vi.fn() });
    expect(manager.needsReauth()).toBe(false);
  });

  it('is false right after a normal online login (fresh, non-expired JWT)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });

    await manager.establishOnlineSession(freshJwt);
    expect(manager.needsReauth()).toBe(false);
  });

  it('is true once the cached JWT\'s exp claim has passed', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });

    await manager.establishOnlineSession(expiredJwt);
    expect(manager.needsReauth()).toBe(true);
  });

  it('goes back to false once a fresh online login replaces the expired cached session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    const expiredJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) - 3600 });
    await manager.establishOnlineSession(expiredJwt);
    expect(manager.needsReauth()).toBe(true);

    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });
    await manager.establishOnlineSession(freshJwt);
    expect(manager.needsReauth()).toBe(false);
  });
});

describe('logoutSession', () => {
  it('preserves the cached jwt, marks the session signed-out, and leaves offline-login authorization intact', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });

    const jwt = fakeJwt({ userCode: 'BOLD-001' });
    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    manager.logoutSession();

    expect(secureStore.load().jwt).toBe(jwt);
    expect(secureStore.load().signedOut).toBe(true);
    expect(manager.getSession()).toBeNull();
    expect(manager.isOfflineLoginAllowed('BOLD-001')).toBe(true);
  });

  it('offline login with the same password still succeeds afterward, returning a non-null jwt and clearing signedOut', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    manager.logoutSession();

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(true);
    expect(result.jwt).toBeTruthy();
    expect(secureStore.load().signedOut).toBe(false);
  });

  it('is a no-op and does not throw when there is no cached session at all', () => {
    const { manager } = buildManager({ fetchImpl: vi.fn() });
    expect(() => manager.logoutSession()).not.toThrow();
    expect(manager.getSession()).toBeNull();
  });
});

describe('forgetDevice', () => {
  it('revokes offline-login authorization and exposes no active session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }));
    manager.forgetDevice();

    expect(manager.getSession()).toBeNull();
    expect(manager.isOfflineLoginAllowed('BOLD-001')).toBe(false);
  });

  it('subsequent offline login fails with device_not_authorized_offline', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });

    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'CorrectHorse123');
    manager.forgetDevice();

    const result = await manager.verifyOfflineLogin('BOLD-001', 'CorrectHorse123');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('device_not_authorized_offline');
  });

  it('fires a best-effort DELETE using the previously-cached jwt when network is allowed', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager } = buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt);
    fetchImpl.mockClear();
    manager.forgetDevice();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/devices/${DEVICE}`,
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: `Bearer ${jwt}` }) })
    );
  });

  it('keeps only a non-sensitive secure tombstone if the immediate DELETE fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    fetchImpl.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

    expect(() => manager.forgetDevice()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = secureStore.load();
    expect(stored).toEqual({ signedOut: true, pendingServerRevoke: { deviceId: DEVICE, userCode: 'BOLD-001' } });
    expect(JSON.stringify(stored)).not.toContain(jwt);
    expect(JSON.stringify(stored)).not.toContain('CorrectHorse123');
    expect(manager.getSession()).toBeNull();
  });

  it('allowNetwork:false never exports the cached jwt and stores only deviceId in secureStore', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const { manager, secureStore } = buildManager({ fetchImpl });
    const jwt = fakeJwt({ userCode: 'BOLD-001' });

    await manager.establishOnlineSession(jwt, 'CorrectHorse123');
    fetchImpl.mockClear();
    const result = manager.forgetDevice({ allowNetwork: false });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ pendingServerRevoke: null });
    expect(secureStore.load()).toEqual({ signedOut: true, pendingServerRevoke: { deviceId: DEVICE, userCode: 'BOLD-001' } });
    expect(JSON.stringify(secureStore.load())).not.toContain(jwt);
    expect(manager.isOfflineLoginAllowed('BOLD-001')).toBe(false);
  });

  it('uses the next fresh online JWT to settle a pending revoke before re-registering the device', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = buildManager({ fetchImpl });
    const oldJwt = fakeJwt({ userCode: 'BOLD-001' });
    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });

    await manager.establishOnlineSession(oldJwt, 'CorrectHorse123');
    manager.forgetDevice({ allowNetwork: false });
    fetchImpl.mockClear();
    calls.length = 0;

    await manager.establishOnlineSession(freshJwt, 'CorrectHorse123');

    expect(calls[0].url).toBe(`https://api.test/api/devices/${DEVICE}`);
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${freshJwt}`);
    expect(calls[1].url).toBe('https://api.test/api/devices/register');
    expect(secureStore.load().jwt).toBe(freshJwt);
    expect(secureStore.load().pendingServerRevoke).toBeUndefined();
  });

  it('never uses a different account JWT to settle an older account pending revoke', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const { manager, secureStore } = buildManager({ fetchImpl });
    await manager.establishOnlineSession(fakeJwt({ userCode: 'BOLD-001' }), 'PasswordA');
    manager.forgetDevice({ allowNetwork: false });
    fetchImpl.mockClear();
    calls.length = 0;

    const userBJwt = fakeJwt({ userCode: 'BOLD-002', exp: Math.floor(Date.now() / 1000) + 3600 });
    await manager.establishOnlineSession(userBJwt, 'PasswordB');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test/api/devices/register');
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${userBJwt}`);
    expect(secureStore.load().userCode).toBe('BOLD-002');
    expect(secureStore.load().pendingServerRevoke).toBeUndefined();
  });
});
