import { describe, it, expect, vi, beforeEach } from 'vitest';

// This test proves the *real* production call sites in main.js -- the
// electron-updater feed configuration and the update:approve/update:install/
// update:getAvailable IPC handlers registered via registerIpcHandlers() as
// part of the normal app.whenReady() startup flow.
//
// electron-updater itself, electron, and every other module main.js imports
// are mocked below so the module can be loaded under plain Node (vitest's
// `node` environment) -- none of electron's native bindings (or a real
// update feed) exist there.
const { ipcHandlers, makeWindow, fakeAutoUpdater, fakeRmSync, emit } = vi.hoisted(() => {
  const ipcHandlers = new Map();
  const listeners = new Map();

  function makeWindow() {
    return {
      webContents: {
        setWindowOpenHandler: () => {},
        on: () => {},
        send: () => {},
        getURL: () => 'http://localhost:57813/',
      },
      on: () => {},
      once: () => {},
      show: () => {},
      maximize: () => {},
      loadURL: async () => {},
      isDestroyed: () => false,
      close: () => {},
      isMinimized: () => false,
      focus: () => {},
      setMenuBarVisibility: () => {},
    };
  }

  const fakeAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn((event, cb) => listeners.set(event, cb)),
  };

  function emit(event, payload) {
    listeners.get(event)?.(payload);
  }

  return { ipcHandlers, makeWindow, fakeAutoUpdater, fakeRmSync: vi.fn(), emit };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual, rmSync: fakeRmSync } };
});

vi.mock('electron', () => {
  class BrowserWindow {
    constructor() {
      return makeWindow();
    }
    static getAllWindows() {
      return [];
    }
  }
  return {
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => {},
      isPackaged: true,
      getPath: () => '/tmp/bqi-test-userdata',
      getVersion: () => '1.0.0',
      whenReady: () => Promise.resolve(),
      on: () => {},
    },
    BrowserWindow,
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] },
    ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    shell: { openPath: () => {}, openExternal: () => {} },
    safeStorage: {},
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
  };
});

// Mirrors main.js's actual import shape (`import pkg from 'electron-updater';
// const { autoUpdater } = pkg;`) rather than a named export, so this test
// would have caught the real "Named export 'autoUpdater' not found"
// packaged-app crash if it had been in place before that shipped.
vi.mock('electron-updater', () => ({ default: { autoUpdater: fakeAutoUpdater } }));

vi.mock('./diagnostics.js', () => ({
  createDiagnostics: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('./db/index.js', () => ({ openDatabase: () => ({}) }));
vi.mock('./db/dbKey.js', () => ({ createDbKeyStore: () => ({ getOrCreateKey: () => null }) }));
vi.mock('./db/analysesRepo.js', () => ({
  listAnalyses: () => [],
  getAnalysis: () => null,
  createAnalysis: () => ({}),
  updateAnalysis: () => ({}),
  deleteAnalysis: () => ({}),
}));
vi.mock('./auth/deviceId.js', () => ({ getOrCreateDeviceId: () => 'device-1' }));
vi.mock('./auth/secureStore.js', () => ({ createSecureStore: () => ({}) }));
vi.mock('./auth/session.js', () => ({
  createSessionManager: () => ({ getSession: () => null, needsReauth: () => false }),
}));
vi.mock('./sync/engine.js', () => ({ runSync: () => Promise.resolve({ ok: true }) }));
vi.mock('./sync/conflict.js', () => ({ listUnresolvedConflicts: () => [], resolveConflict: () => null }));
vi.mock('./localAI/provider.js', () => ({ createLocalAIProvider: () => ({ query: () => ({}) }) }));
vi.mock('./localAI/registry.js', () => ({ configureLocalLLM: () => {}, getModelManager: () => ({}) }));
vi.mock('./connectivity.js', () => ({
  createConnectivityMonitor: () => ({
    onChange: () => {},
    start: () => {},
    onReconnect: () => {},
    stop: () => {},
    getState: () => 'local',
    checkOnce: () => Promise.resolve(),
  }),
}));
vi.mock('./staticServer.js', () => ({ serveStaticDir: () => Promise.resolve({ url: 'http://localhost:57813' }) }));

describe('desktop update wiring (desktop/main.js + electron-updater)', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    fakeAutoUpdater.setFeedURL.mockClear();
    fakeAutoUpdater.checkForUpdates.mockClear();
    fakeAutoUpdater.downloadUpdate.mockClear();
    fakeAutoUpdater.quitAndInstall.mockClear();
    fakeRmSync.mockClear();
    delete process.env.BQI_DESKTOP_DEV;
    delete process.env.BQI_DESKTOP_FORCE_PROD;
    delete process.env.BQI_CLOUD_URL;
  });

  it('clears both the cached blockmap and the cached base installer before downloading', async () => {
    // A stale/corrupt local installer.exe cache fails the differential
    // download's SHA-512 check deterministically, no matter how many times
    // it's retried -- clearing only current.blockmap (the old mitigation)
    // leaves that corrupt base file in place and the diff keeps failing.
    // Both derived-cache files must be cleared together so a bad base can
    // never be diffed against; see removeCachedBlockmapBeforeUpdate's
    // comment in main.js.
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: '' });
    await ipcHandlers.get('update:approve')();

    expect(fakeRmSync).toHaveBeenCalledWith(
      expect.stringMatching(/bqi-updater[\\/]current\.blockmap$/),
      { force: true },
    );
    expect(fakeRmSync).toHaveBeenCalledWith(
      expect.stringMatching(/bqi-updater[\\/]installer\.exe$/),
      { force: true },
    );
  });

  it('points the generic update feed at this app\'s own server, never at GitHub', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fakeAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    const feedConfig = fakeAutoUpdater.setFeedURL.mock.calls[0][0];
    expect(feedConfig.provider).toBe('generic');
    expect(feedConfig.url).toContain('/api/version/generic');
    expect(feedConfig.url).not.toContain('github');
    // Gated behind explicit user approval (update:approve), same contract
    // the old custom flow had -- electron-updater must not download on its
    // own the moment a version check finds something newer.
    expect(fakeAutoUpdater.autoDownload).toBe(false);
    // Our own /generic/download/:filename route forwards Range verbatim to
    // GitHub's asset API, which rejects the combined multi-range request
    // The server splits electron-updater's combined Range request into
    // bounded concurrent upstream requests, so the client should retain
    // multi-range mode instead of paying one round-trip per changed block.
    expect(feedConfig.useMultipleRangeRequest).toBe(true);
  });

  it('runs a check on startup via autoUpdater.checkForUpdates, not a direct GitHub/API call', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('update-available populates pendingUpdate; update:approve forwards to autoUpdater.downloadUpdate', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: 'test release' });

    const getAvailable = ipcHandlers.get('update:getAvailable');
    expect(getAvailable()).toEqual({ available: true, version: '9.9.9', notes: 'test release' });

    const approve = ipcHandlers.get('update:approve');
    const result = await approve();

    expect(result).toEqual({ ok: true });
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('update:approve cancels and rejects a download that stalls (no download-progress for 60s), instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      fakeAutoUpdater.downloadUpdate.mockImplementationOnce(
        (token) => new Promise((_resolve, reject) => {
          token.onCancel(() => reject(new Error('cancelled')));
        }),
      );
      await import('./main.js');
      await vi.advanceTimersByTimeAsync(50);

      emit('update-available', { version: '9.9.9', releaseNotes: '' });
      const approve = ipcHandlers.get('update:approve');
      const resultPromise = approve();

      // No download-progress event ever fires; advance past the 60s stall
      // threshold (in 10s watchdog-tick increments) and the download must
      // be cancelled rather than left hanging.
      await vi.advanceTimersByTimeAsync(70_000);

      const result = await resultPromise;
      expect(result).toEqual({ ok: false, error: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('update:approve fails closed when no update was ever announced', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const approve = ipcHandlers.get('update:approve');
    const result = await approve();

    expect(result).toEqual({ ok: false, error: 'update_not_found' });
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('update:approve surfaces a failed differential/full download instead of silently succeeding', async () => {
    vi.resetModules();
    fakeAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: '' });
    const approve = ipcHandlers.get('update:approve');
    const result = await approve();

    expect(result).toEqual({ ok: false, error: 'sha512 checksum mismatch' });
  });

  it('update:install refuses to run until update-downloaded has actually fired (never installs a partial/unverified download)', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: '' });
    const install = ipcHandlers.get('update:install');
    const result = await install();

    expect(result).toEqual({ ok: false, error: 'installer_missing' });
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('update:install calls autoUpdater.quitAndInstall once the download has completed', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: '' });
    emit('update-downloaded', {});
    const install = ipcHandlers.get('update:install');
    const result = await install();

    expect(result).toEqual({ ok: true });
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    // Must run silently: the NSIS config is oneClick:false (an assisted
    // installer with an install-dir picker etc.), and quitAndInstall()'s
    // default (isSilent: false) would re-show that entire first-run wizard
    // on every update instead of a silent in-place upgrade + relaunch.
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('a fresh approve() after a prior successful install cycle requires a new update-downloaded before installing again', async () => {
    vi.resetModules();
    await import('./main.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    emit('update-available', { version: '9.9.9', releaseNotes: '' });
    emit('update-downloaded', {});
    await ipcHandlers.get('update:install')();

    // A newer version replacing pendingUpdate resets the "ready" flag --
    // re-approving must download again before install can run, rather than
    // reusing the previous version's already-installed state.
    emit('update-available', { version: '10.0.0', releaseNotes: '' });
    const install = ipcHandlers.get('update:install');
    const result = await install();

    expect(result).toEqual({ ok: false, error: 'installer_missing' });
  });
});
