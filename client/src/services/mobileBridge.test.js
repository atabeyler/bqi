import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeSqliteConnection } from '../mobile/testHelpers.js';

function fakeJwt(payload) {
  const b64 = btoa(JSON.stringify(payload));
  return `header.${b64}.signature`;
}

function fakeSecureStorage() {
  const map = new Map();
  return {
    getItem: vi.fn(async (key) => (map.has(key) ? map.get(key) : null)),
    setItem: vi.fn(async (key, value) => { map.set(key, value); }),
    removeItem: vi.fn(async (key) => { map.delete(key); }),
  };
}

function mockNativePlugins() {
  const fakeSqlite = createFakeSqliteConnection();
  vi.doMock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  }));
  vi.doMock('@capacitor-community/sqlite', () => ({
    SQLiteConnection: class {
      isConnection(...args) { return fakeSqlite.isConnection(...args); }
      createConnection(...args) { return fakeSqlite.createConnection(...args); }
      retrieveConnection(...args) { return fakeSqlite.retrieveConnection(...args); }
      closeConnection(...args) { return fakeSqlite.closeConnection(...args); }
    },
    CapacitorSQLite: {},
  }));
  vi.doMock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: fakeSecureStorage() }));
}

let trackedListeners = [];
const realAddEventListener = window.addEventListener.bind(window);
beforeEach(() => {
  trackedListeners = [];
  vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, opts) => {
    if (type === 'bqi:app-mode-change') trackedListeners.push(handler);
    return realAddEventListener(type, handler, opts);
  });
});

afterEach(() => {
  for (const handler of trackedListeners) window.removeEventListener('bqi:app-mode-change', handler);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.doUnmock('@capacitor/core');
  vi.doUnmock('@capacitor-community/sqlite');
  vi.doUnmock('@aparajita/capacitor-secure-storage');
  vi.doUnmock('../mobile/sync/engine.js');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('mobileBridge -- Offline Mode connectivity gate', () => {
  it('checkConnectivity reports "local" with no /api/health fetch while Offline Mode is on', async () => {
    localStorage.setItem('bqi_app_mode', 'offline');
    mockNativePlugins();
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();

    const { mobileConnectivity } = await import('./mobileBridge.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(await mobileConnectivity.getState()).toBe('local');
    const healthCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/health'));
    expect(healthCalls).toHaveLength(0);
  });

  it('an offline -> auto flip triggers exactly one reconciling checkConnectivity call', async () => {
    localStorage.setItem('bqi_app_mode', 'offline');
    mockNativePlugins();
    const fetchMock = vi.fn(async (url) => (String(url).includes('/api/health') ? { ok: true } : { ok: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();

    const { mobileConnectivity } = await import('./mobileBridge.js');
    const appModePref = await import('./appModePreference.js');
    await new Promise((r) => setTimeout(r, 0));
    fetchMock.mockClear();

    appModePref.setAppMode('auto');
    await new Promise((r) => setTimeout(r, 0));

    const healthCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/health'));
    expect(healthCalls).toHaveLength(1);
    expect(await mobileConnectivity.getState()).toBe('cloud');
  });
});

describe('mobileBridge -- Offline Mode sync gate', () => {
  it('performSync (via mobileSync.forceSync) skips the sync engine entirely while Offline Mode is on', async () => {
    localStorage.setItem('bqi_app_mode', 'offline');
    mockNativePlugins();
    const runSyncSpy = vi.fn();
    vi.doMock('../mobile/sync/engine.js', () => ({ runSync: runSyncSpy }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    vi.resetModules();

    const { mobileSync } = await import('./mobileBridge.js');
    const result = await mobileSync.forceSync();

    expect(result).toEqual({ ok: false, skipped: true });
    expect(runSyncSpy).not.toHaveBeenCalled();
  });
});

describe('mobileBridge -- forgetDevice offline/online handoff', () => {
  it('never persists a bearer token in localStorage; the next online login uses its fresh JWT for the server revoke', async () => {
    mockNativePlugins();
    const registerCalls = [];
    const deleteCalls = [];
    const fetchMock = vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/api/devices/register')) {
        registerCalls.push({ url: u, options });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (options.method === 'DELETE' && u.includes('/api/devices/')) {
        deleteCalls.push({ url: u, options });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (u.includes('/api/health')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();

    const { mobileAuth } = await import('./mobileBridge.js');
    const appModePref = await import('./appModePreference.js');

    const firstJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 3600 });
    await mobileAuth.establishOnlineSession(firstJwt, 'pw');
    expect(registerCalls).toHaveLength(1);

    appModePref.setAppMode('offline');
    const result = await mobileAuth.forgetDevice();

    expect(result).toEqual({ pendingServerRevoke: null });
    expect(deleteCalls).toHaveLength(0);
    expect(localStorage.getItem('bqi_pending_device_revoke')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(firstJwt);

    // Returning to Auto restores connectivity, but there is deliberately no
    // old bearer token available to perform a safe authenticated DELETE.
    appModePref.setAppMode('auto');
    await new Promise((r) => setTimeout(r, 0));
    expect(deleteCalls).toHaveLength(0);

    const freshJwt = fakeJwt({ userCode: 'BOLD-001', exp: Math.floor(Date.now() / 1000) + 7200 });
    await mobileAuth.establishOnlineSession(freshJwt, 'pw');

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].options.headers.Authorization).toBe(`Bearer ${freshJwt}`);
    expect(registerCalls).toHaveLength(2);
  });

  it('removes the v3.2.0 legacy plaintext pending-revoke localStorage key on startup', async () => {
    localStorage.setItem('bqi_pending_device_revoke', JSON.stringify({ deviceId: 'BQI-AND-OLD', jwt: 'legacy-plaintext-token' }));
    mockNativePlugins();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    vi.resetModules();

    await import('./mobileBridge.js');

    expect(localStorage.getItem('bqi_pending_device_revoke')).toBeNull();
  });
});
