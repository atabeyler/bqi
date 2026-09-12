import { app, BrowserWindow, Menu, ipcMain, shell, safeStorage, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDiagnostics } from './diagnostics.js';
import { openDatabase } from './db/index.js';
import { createDbKeyStore } from './db/dbKey.js';
import { listAnalyses, getAnalysis, createAnalysis, updateAnalysis, deleteAnalysis } from './db/analysesRepo.js';
import { getOrCreateDeviceId } from './auth/deviceId.js';
import { createSecureStore } from './auth/secureStore.js';
import { createSessionManager } from './auth/session.js';
import { runSync } from './sync/engine.js';
import { listUnresolvedConflicts, resolveConflict } from './sync/conflict.js';
import { createLocalAIProvider } from './localAI/provider.js';
import { configureLocalLLM, getModelManager, listModelTiers, setModelTier } from './localAI/registry.js';
import { createConnectivityMonitor } from './connectivity.js';
import { createAppModeController } from './appMode.js';
import { serveStaticDir } from './staticServer.js';
// electron-updater is a CommonJS package with no "exports" map telling
// Node's ESM interop which of its properties are safe to statically
// detect as named exports -- `import { autoUpdater } from 'electron-updater'`
// throws "Named export 'autoUpdater' not found" in a packaged app (this
// only surfaced after shipping; the dev/test runs here all went through a
// mocked module, which bypasses Node's real CJS/ESM interop entirely).
// Importing the default and destructuring is what Node itself suggests as
// the fix, and works in both packaged and unpackaged runs.
import electronUpdaterPkg from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
const { autoUpdater } = electronUpdaterPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The deployed web app is the source of truth this points at by default;
// override with BQI_CLOUD_URL for a self-hosted/staging server.
const CLOUD_URL = process.env.BQI_CLOUD_URL || 'https://site--anatoliaboldq--6ftfc8q7458m.code.run';
// Same origin as CLOUD_URL, ws(s): scheme -- Socket.IO upgrades its
// connection to this scheme, so CSP's connect-src needs it listed
// explicitly (see the CSP header below); scoped to this one origin rather
// than the bare `wss:`/`ws:` schemes, which would allow a WebSocket to ANY
// host.
const CLOUD_WS_URL = CLOUD_URL.replace(/^http/, 'ws');
// Fixed (not random) so it can be allowlisted in the server's CORS config
// (server/src/index.js) -- see the loadURL call below.
const STATIC_SERVER_PORT = 57813;
// BQI_DESKTOP_FORCE_PROD lets an unpackaged checkout (npm run desktop,
// or this project's own smoke tests) exercise the production static-server
// load path without needing a full electron-builder build first.
const isDev = process.env.BQI_DESKTOP_FORCE_PROD !== '1'
  && (!app.isPackaged || process.env.BQI_DESKTOP_DEV === '1');

// Only one running instance touches the local SQLite file at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let splashWindow = null;
let db = null;
let deviceId = null;
let sessionManager = null;
let connectivity = null;
let appMode = null;
let syncTimer = null;
let updateTimer = null;
// Mirrors startBackgroundServices()/pauseBackgroundServices() -- tracks
// whether the timers + connectivity polling are currently running, since
// (unlike before Offline Mode existed) `connectivity` itself is now created
// once at startup and kept alive across a pause instead of being recreated/
// nulled, so its presence can no longer be used as that signal (see
// app.on('activate') below).
let backgroundServicesRunning = false;
// Created before anything else in app.whenReady() so every subsequent
// step (db open, sync, IPC handlers) can log through it; diagnostics.js
// itself never throws, so this is safe to call unconditionally everywhere
// below even before that assignment runs (only during the brief window
// before whenReady resolves, which none of this code executes in).
let diagnostics = null;
// Set once electron-updater's 'update-available' event fires (see
// configureAutoUpdater below), read by the update:approve/update:install/
// update:getAvailable IPC handlers.
let pendingUpdate = null;
let updateReadyToInstall = false;
let splashShownAt = 0;
let updateCheckInFlight = false;
// Timestamp of the last 'download-progress' event, used by update:approve's
// stall watchdog below to detect a download that has silently frozen (see
// that handler for why this is needed).
let lastDownloadProgressAt = 0;
const UPDATER_CACHE_DIR_NAME = 'bqi-updater';

// electron-updater's own UpdateInfo carries more than the renderer needs
// (and releaseNotes can be a per-version array instead of a string,
// depending on how many versions were skipped) -- narrow it down to the
// {available, version, notes} shape the renderer's UpdateBanner already
// expects from the old custom update flow.
function toRendererUpdateInfo(info) {
  return {
    available: true,
    version: info.version,
    notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
  };
}

function removeCachedBlockmapBeforeUpdate() {
  // electron-updater's NSIS differential downloader reads its "old file"
  // baseline from two separate items in this cache dir (see
  // AppUpdater.js's differentialDownloadInstaller): a cached copy of the
  // previously-downloaded installer, <cache>/installer.exe (the actual
  // bytes it copies "unchanged" blocks from), and <cache>/current.blockmap
  // (the plan of which blocks are unchanged, preferred over re-downloading
  // the previous release's blockmap when present). The two are only ever
  // written together, right after a successful download -- but installer.exe
  // can independently end up stale or truncated (an update download that
  // was interrupted mid-write by a flaky/overloaded update server, or a
  // manual installer run outside electron-updater's own flow), leaving a
  // cache that no longer matches ANY real published build. A previous fix
  // here only cleared current.blockmap, on the theory that the *plan* was
  // stale while installer.exe itself was still trustworthy -- but a
  // mismatched-or-corrupt installer.exe fails the differential's final
  // SHA-512 check every single time regardless of how fresh the blockmap
  // plan is, since the plan just tells it *which* bytes to copy from a base
  // file that's wrong to begin with. Clearing both together removes any
  // chance of diffing against a corrupt base: with installer.exe absent,
  // electron-updater's open() on it fails immediately, which is caught by
  // differentialDownloadInstaller's own try/catch and falls back to a full
  // download right away -- instead of silently reconstructing a mismatched
  // file and only discovering the corruption after a wasted round-trip.
  // User data and the currently-installed application are
  // untouched; this only clears electron-updater's own derived cache.
  const cacheDir = path.join(app.getPath('cache'), UPDATER_CACHE_DIR_NAME);
  for (const name of ['current.blockmap', 'installer.exe']) {
    try {
      fs.rmSync(path.join(cacheDir, name), { force: true });
    } catch (err) {
      diagnostics?.warn('update_cache_clear_failed', { file: name, message: err?.message });
      continue;
    }
    diagnostics?.info('update_cache_cleared', { file: name });
  }
}

// electron-updater's own "generic" provider feed, served by this app's own
// server (see server/src/routes/version.js's /generic/*) instead of ever
// pointing at GitHub -- that route proxies electron-builder's published
// latest.yml/latest-mac.yml/latest-linux.yml and each installer's
// .blockmap through, rewriting every URL inside to itself first, so
// nothing in the update flow (metadata *or* the differential download
// requests) ever names github.com to the client. Configured lazily so
// tests that stub electron-updater don't need CLOUD_URL to resolve to
// anything real.
function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep electron-updater's multi-range mode enabled. The update proxy
  // splits that request into bounded concurrent single-range requests for
  // GitHub (whose asset CDN rejects multi-range directly) and assembles a
  // standards-compliant multipart response. Sending one request per block
  // from the desktop made even a ~4 MB patch take minutes because every
  // changed block paid a full network round-trip.
  autoUpdater.setFeedURL({ provider: 'generic', url: `${CLOUD_URL}/api/version/generic`, useMultipleRangeRequest: true });
  // electron-builder's NSIS target here produces a single self-contained
  // installer, never a separate "web installer" stub + downloaded package
  // -- explicitly declaring that stops electron-updater's own logger from
  // warning on every single update check that this should be set (it also
  // says the default flips to true in a future version anyway).
  autoUpdater.disableWebInstaller = true;

  // NsisUpdater's default post-download check shells out to PowerShell's
  // Get-AuthenticodeSignature and requires it to report the installer's
  // signature as fully chain-trusted (Status: Valid) -- which a
  // self-signed certificate (see desktop/README.md's "Code signing"
  // section on why this repo doesn't use a paid CA-issued one) never is,
  // on any machine that hasn't manually imported it. Every real download
  // was failing this check and surfacing as an opaque "Download failed"
  // in the renderer, even though the bytes downloaded fine. Overriding it
  // to a no-op doesn't weaken integrity: electron-updater's sha512 check
  // against latest.yml (fetched over HTTPS from this app's own server,
  // itself proxying GitHub's asset digest) already runs unconditionally
  // and independently of this signature step, and a self-signed cert's
  // "chain of trust" wasn't establishing real publisher identity anyway --
  // anyone can mint one with the same subject name.
  autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);

  // electron-updater logs its own reasoning (differential-vs-full download
  // decisions, why a diff attempt fell back, signature/hash mismatches) via
  // this logger interface -- without wiring it up those messages just go to
  // an unattached console in a packaged app and are lost. Routing them into
  // the same desktop.log diagnostics already write to is the only way to
  // find out *why* a given update went one path or the other after the
  // fact, e.g. from a user-submitted log.
  autoUpdater.logger = {
    info: (message) => diagnostics?.info('autoupdater', { message }),
    warn: (message) => diagnostics?.warn('autoupdater', { message }),
    error: (message) => diagnostics?.error('autoupdater', { message }),
  };

  autoUpdater.on('update-available', (info) => {
    if (pendingUpdate?.version === info.version) return;
    pendingUpdate = toRendererUpdateInfo(info);
    updateReadyToInstall = false;
    diagnostics?.info('update_available', { version: info.version });
    mainWindow?.webContents.send('update:available', pendingUpdate);
  });
  autoUpdater.on('update-downloaded', () => {
    updateReadyToInstall = true;
  });
  autoUpdater.on('download-progress', (progress) => {
    lastDownloadProgressAt = Date.now();
    mainWindow?.webContents.send('update:progress', { received: Math.round(progress.transferred), total: Math.round(progress.total) });
  });
  autoUpdater.on('error', (err) => {
    diagnostics?.error('update_error', { message: err?.message });
  });
}

function createSplashWindow() {
  const bqiLogoPath = path.join(__dirname, '..', 'client', 'dist', 'bqi-logo.png');
  const iconPath = fs.existsSync(bqiLogoPath) ? bqiLogoPath : path.join(__dirname, 'build', 'icon.png');
  const iconData = fs.readFileSync(iconPath).toString('base64');
  const splashHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>BQI</title>
      <style>
        :root { color-scheme: dark; }
        html, body { width: 100%; height: 100%; margin: 0; }
        body {
          overflow: hidden;
          background:
            radial-gradient(circle at 50% 38%, rgba(0, 120, 180, 0.22), transparent 34%),
            linear-gradient(180deg, #08111f 0%, #050a14 100%);
          color: #ecfeff;
          display: grid;
          place-items: center;
          font-family: "Cinzel", "Times New Roman", serif;
          letter-spacing: 0.28em;
          text-transform: uppercase;
        }
        .frame {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
          padding: 32px 28px;
          border: 1px solid rgba(0, 212, 255, 0.16);
          background: rgba(2, 8, 18, 0.42);
          box-shadow:
            0 0 50px rgba(0, 120, 180, 0.12),
            inset 0 0 40px rgba(34, 211, 238, 0.05);
          min-width: 360px;
        }
        img {
          width: 164px;
          height: 164px;
          image-rendering: auto;
          animation: pulse 2.8s ease-in-out infinite;
          filter: drop-shadow(0 0 16px rgba(0, 200, 255, 0.25));
        }
        .title { font-size: 22px; }
        .subtitle {
          font-size: 11px;
          color: rgba(207, 250, 254, 0.72);
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 0.96; }
          50% { transform: scale(1.03); opacity: 1; }
        }
      </style>
    </head>
    <body>
      <div class="frame">
        <img src="data:image/png;base64,${iconData}" alt="BQI" />
        <div class="title">BQI</div>
        <div class="subtitle">BOLD QUANTUM INTELLIGENCE</div>
      </div>
    </body>
  </html>`;

  splashShownAt = Date.now();
  splashWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: true,
    frame: false,
    center: true,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#050a14',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  splashWindow.on('closed', () => { splashWindow = null; });
  return splashWindow;
}

function hideSplashThenShowMain() {
  // Matches DISPLAY_MS in client/src/components/SplashScreen.jsx (the
  // in-app splash Android/PWA show instead of this native window) so the
  // pre-login launch screen lasts the same amount of time on every
  // platform -- keep the two in sync if either changes.
  const minSplashMs = 2500;
  const remaining = Math.max(0, minSplashMs - (Date.now() - splashShownAt));
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Opens filling the screen (not OS-level kiosk fullscreen, which would
      // also hide the title bar/window controls) -- maximize() keeps those
      // while using the full work area, and still lets the user restore
      // down to the 1400x900 default afterwards.
      mainWindow.maximize();
      mainWindow.show();
    }
  }, remaining);
}

function currentUserCode() {
  return sessionManager?.getSession()?.userCode || null;
}

async function performSync() {
  // Belt-and-suspenders alongside appMode's own timer-pausing (appMode.js's
  // set('offline') stops syncTimer and connectivity's polling) -- this
  // function is also called directly from the analyses:create/update/
  // remove, sync:forceSync, sync:resolveConflict IPC handlers and the
  // "Şimdi Senkronize Et" app-menu item, none of which go through the
  // timer-pause path, so a stale in-flight call could still slip through
  // without this guard.
  if (appMode?.isOffline()) return { ok: false, skipped: true };

  const session_ = sessionManager?.getSession();
  if (!session_ || !db) return;

  // A cached JWT past its own exp claim is a guaranteed 401 on every call
  // -- there's no server-side refresh-token endpoint to silently renew it
  // with, so skip the doomed network round-trip and tell the renderer to
  // prompt for a fresh online login instead (see session.js's needsReauth
  // doc comment). The sync queue and local data are untouched either way;
  // whatever is queued gets pushed automatically the moment
  // establishOnlineSession succeeds again (its IPC handler already
  // triggers a sync right after).
  if (sessionManager.needsReauth()) {
    diagnostics?.warn('reauth_required', {});
    mainWindow?.webContents.send('auth:reauthRequired');
    return { ok: false, error: 'reauth_required', reauthRequired: true };
  }

  connectivity.markSyncing();
  diagnostics?.info('sync_start', {});
  let result;
  try {
    result = await runSync(db, {
      apiBaseUrl: CLOUD_URL,
      getToken: () => session_.jwt,
      deviceId,
      userId: session_.userCode,
    });
  } catch (err) {
    diagnostics?.error('sync_failed', { message: err.message });
    throw err;
  }
  if (result?.ok === false) {
    diagnostics?.warn('sync_failed', { message: result.error });
  } else {
    diagnostics?.info('sync_success', {
      pushed: result?.push?.pushed ?? 0,
      pulled: result?.pull?.pulled ?? 0,
    });
    const conflicts = result?.push?.conflicts ?? 0;
    if (conflicts > 0) diagnostics?.warn('sync_conflict', { count: conflicts });
  }
  await connectivity.checkOnce();
  mainWindow?.webContents.send('connectivity:change', connectivity.getState());
  return result;
}

async function checkAndBroadcastUpdate() {
  if (isDev || !app.isPackaged || updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    // Resolves once electron-updater has fetched and compared the feed;
    // pendingUpdate/the 'update:available' push happen from the
    // 'update-available' listener registered in configureAutoUpdater, not
    // here, since that's also how a version found by a *later* check (the
    // 5-minute interval below) reaches the renderer.
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[AppUpdate] check failed:', err?.message || err);
    diagnostics?.error('update_check_failed', { message: err?.message });
  } finally {
    updateCheckInFlight = false;
  }
}

function registerIpcHandlers() {
  ipcMain.handle('auth:establishOnlineSession', async (_e, jwt, password) => {
    const result = await sessionManager.establishOnlineSession(jwt, password);
    performSync().catch(() => {});
    return result;
  });
  ipcMain.handle('auth:verifyOfflineLogin', (_e, userCode, password) => sessionManager.verifyOfflineLogin(userCode, password));
  ipcMain.handle('auth:getSession', () => sessionManager.getSession());
  // Lets HistoryView.jsx tell "this device"'s own rows apart from ones
  // synced down from elsewhere, for the device label shown next to each
  // report's title -- display-only, never used for auth/sync itself.
  ipcMain.handle('auth:getDeviceId', () => deviceId);
  ipcMain.handle('auth:isOfflineLoginAllowed', (_e, userCode) => sessionManager.isOfflineLoginAllowed(userCode));
  ipcMain.handle('auth:needsReauth', () => sessionManager.needsReauth());
  ipcMain.handle('auth:logoutSession', () => sessionManager.logoutSession());
  ipcMain.handle('auth:forgetDevice', () => {
    // Offline Mode on: skip the server DELETE (there's no connectivity to
    // spend it on) and stash the revoke for appMode's set('auto')
    // reconciliation to retry once the user turns Offline Mode back off --
    // see session.js's forgetDevice({ allowNetwork }) doc comment.
    const result = sessionManager.forgetDevice({ allowNetwork: !appMode.isOffline() });
    if (result?.pendingServerRevoke) appMode.setPendingRevoke(result.pendingServerRevoke);
    return result;
  });

  ipcMain.handle('appMode:get', () => appMode.get());
  ipcMain.handle('appMode:set', (_e, mode) => {
    appMode.set(mode);
    mainWindow?.webContents.send('appMode:changed', mode);
  });

  ipcMain.handle('analyses:list', () => {
    const userId = currentUserCode();
    if (!userId) return [];
    return listAnalyses(db, userId);
  });
  ipcMain.handle('analyses:get', (_e, id) => {
    const userId = currentUserCode();
    return userId ? getAnalysis(db, userId, id) : null;
  });
  ipcMain.handle('analyses:create', (_e, data) => {
    const userId = currentUserCode();
    if (!userId) throw new Error('not_logged_in');
    // userId/deviceId are session-derived and must win over any same-named
    // key the renderer's data object happens to carry -- spreading data
    // first (not last) is what makes that override impossible.
    const row = createAnalysis(db, { ...data, userId, deviceId });
    performSync().catch(() => {});
    return row;
  });
  ipcMain.handle('analyses:update', (_e, id, data) => {
    const userId = currentUserCode();
    if (!userId) throw new Error('not_logged_in');
    const row = updateAnalysis(db, { ...data, userId, deviceId, id });
    performSync().catch(() => {});
    return row;
  });
  ipcMain.handle('analyses:remove', (_e, id) => {
    const userId = currentUserCode();
    if (!userId) throw new Error('not_logged_in');
    const removed = deleteAnalysis(db, { userId, deviceId, id });
    performSync().catch(() => {});
    return removed;
  });

  ipcMain.handle('sync:status', () => ({ state: connectivity.getState(), deviceId }));
  ipcMain.handle('sync:forceSync', () => performSync());
  ipcMain.handle('sync:listConflicts', () => listUnresolvedConflicts(db));
  ipcMain.handle('sync:resolveConflict', (_e, conflictId, resolution) => {
    const resolved = resolveConflict(db, { conflictId, deviceId, resolution });
    if (resolved) performSync().catch(() => {});
    return resolved;
  });

  ipcMain.handle('ai:query', (_e, request) => {
    const userId = currentUserCode();
    if (!userId) return { ok: false, error: 'not_logged_in' };
    return createLocalAIProvider({ db, userId, diagnostics }).query(request);
  });

  // Model Manager IPC surface -- lets a future Settings panel drive
  // install/remove/status for the local LLM without any of this module's
  // logic living in the renderer. Every handler here only touches the
  // local filesystem/device info or, for downloadModel, the one Hugging
  // Face URL pinned in modelSpec.js -- never anything else (spec point 9).
  ipcMain.handle('ai:modelStatus', () => {
    const mm = getModelManager();
    return { installed: mm.isModelInstalled(), partialBytes: mm.getPartialBytes(), available: mm.isAvailable(), capability: mm.checkCapability(), spec: mm.spec };
  });
  ipcMain.handle('ai:modelDownload', async (event) => {
    const mm = getModelManager();
    try {
      const result = await mm.downloadModel({
        onProgress: (progress) => event.sender.send('ai:modelDownloadProgress', progress),
      });
      diagnostics.info('local_llm_model_installed', { sha256: result.sha256 });
      return { ok: true, ...result };
    } catch (err) {
      if (err.cancelled) {
        diagnostics.info('local_llm_model_download_cancelled', { deleted: !!err.deletePartial });
        return { ok: false, cancelled: true };
      }
      diagnostics.error('local_llm_model_download_failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });
  // "Durdur" (deletePartial: false) pauses the in-flight download while
  // keeping the .download file for the next Range-resumed attempt;
  // "İptal" (deletePartial: true) also deletes it. Either way the pending
  // ai:modelDownload call above settles (rejects) on its own once the
  // aborted request/stream actually stops -- this handler only signals it.
  ipcMain.handle('ai:modelDownloadCancel', (_event, options) => getModelManager().cancelDownload(options));
  ipcMain.handle('ai:modelRemove', async () => getModelManager().removeModel());

  // Manual tier picker (Settings > Local AI): list the pinned tiers, then
  // repoint modelManager at the chosen one. Selecting a tier never touches
  // any file itself -- the renderer is expected to have removed the
  // previously-installed model first (see LocalAIPanel.jsx) and then call
  // ai:modelDownload for the newly-selected tier.
  ipcMain.handle('ai:modelTiers', () => listModelTiers());
  ipcMain.handle('ai:modelSelectTier', (_event, tier) => {
    try {
      const mm = setModelTier(tier);
      return { ok: true, installed: mm.isModelInstalled(), partialBytes: mm.getPartialBytes(), available: mm.isAvailable(), capability: mm.checkCapability(), spec: mm.spec };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('connectivity:getState', () => connectivity.getState());

  // The renderer's update banner calls these once the user has explicitly
  // approved installing the version reported by the 'update:available'
  // event (see configureAutoUpdater above). electron-updater's own
  // differential (blockmap) downloader and per-file sha512 verification
  // (against the values in the generic feed's latest.yml, itself proxied
  // through this app's own server -- see server/src/routes/version.js)
  // replace the previous hand-rolled download+SHA-256-check flow: a
  // failing verification rejects downloadUpdate() below the same way a
  // checksum mismatch used to, so nothing partially-downloaded or
  // tampered-with ever reaches quitAndInstall().
  ipcMain.handle('update:approve', async () => {
    if (!pendingUpdate) return { ok: false, error: 'update_not_found' };
    updateReadyToInstall = false;
    // A stalled connection (dropped wifi, a rate-limited/half-open proxy)
    // leaves Node's http request neither erroring nor completing -- the
    // symptom users report as the progress bar freezing at some percentage
    // forever, since electron-updater has no built-in timeout of its own.
    // This watchdog cancels the download if no download-progress event has
    // fired for a while, which turns that silent hang into a real rejection
    // the renderer's "Try Again" button can act on.
    const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
    lastDownloadProgressAt = Date.now();
    const cancellationToken = new CancellationToken();
    const watchdog = setInterval(() => {
      if (Date.now() - lastDownloadProgressAt > DOWNLOAD_STALL_TIMEOUT_MS) {
        diagnostics?.warn('update_download_stalled', { version: pendingUpdate?.version });
        cancellationToken.cancel();
      }
    }, 10_000);
    try {
      removeCachedBlockmapBeforeUpdate();
      await autoUpdater.downloadUpdate(cancellationToken);
      diagnostics?.info('update_downloaded', { version: pendingUpdate.version });
      return { ok: true };
    } catch (err) {
      diagnostics?.error('update_download_failed', { message: err?.message });
      return { ok: false, error: err?.message || 'İndirme başarısız' };
    } finally {
      clearInterval(watchdog);
    }
  });
  ipcMain.handle('update:getAvailable', () => pendingUpdate);
  ipcMain.handle('update:install', () => {
    if (!updateReadyToInstall) return { ok: false, error: 'installer_missing' };
    // quitAndInstall handles the quit-then-relaunch-installer dance itself
    // per platform (Windows: runs the NSIS installer and quits; macOS:
    // swaps the .app bundle; Linux: replaces the running AppImage in
    // place) -- unlike the old shell.openPath flow, there's no separate
    // "did the OS actually manage to open this file" failure mode to
    // report back, and no manual app.quit() needed alongside it.
    //
    // isSilent must be true: quitAndInstall()'s default (false) runs the
    // NSIS installer interactively, and since package.json's build.nsis
    // sets oneClick:false (an "assisted" installer, needed for the
    // install-dir/shortcut options on a first-time install), an unsilenced
    // update re-shows that entire first-run wizard ("Yükleme Ayarlarını
    // Seçin" -- pick per-user/per-machine, install dir, etc.) on every
    // update instead of just relaunching with the new version. isForceRunAfter
    // relaunches the app once the silent install finishes, matching what a
    // user expects from "Install and Restart".
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    // Includes the running version so the taskbar/title bar itself
    // confirms which build is active -- handy for confirming an update
    // actually landed without opening Settings -> About.
    title: `BQI v${app.getVersion()}`,
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Electron re-syncs the window title to the page's own <title> on every
  // navigation by default, which would immediately overwrite the
  // version-carrying title set above -- keep the OS-level title pinned to
  // it regardless of what the page sets.
  mainWindow.on('page-title-updated', (event) => { event.preventDefault(); });

  // No external navigation and no new windows out of the app shell — any
  // http(s) link opens in the OS browser instead of inside this window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const current = new URL(mainWindow.webContents.getURL());
    if (target.origin !== current.origin) {
      event.preventDefault();
      // Mirrors setWindowOpenHandler's own scheme check above -- without
      // it, a cross-origin will-navigate to ANY scheme (not just http/https:
      // a custom URI handler another installed app registered, file:, etc.)
      // was unconditionally handed to shell.openExternal(), which on
      // Windows can invoke a registered handler with attacker-influenced
      // arguments. Only http(s) links are worth handing off to the OS
      // browser at all; everything else is just dropped.
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        shell.openExternal(url);
      }
    }
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    const clientDist = path.join(__dirname, '..', 'client', 'dist');
    // Fixed, not random, port: this origin needs to be allowlisted in the
    // server's CORS config (server/src/index.js's ELECTRON_APP_ORIGIN) for
    // api.js's cross-origin calls to CLOUD_URL to work at all.
    const { url } = await serveStaticDir(clientDist, { port: STATIC_SERVER_PORT });
    await mainWindow.loadURL(url);
  }

  mainWindow.once('ready-to-show', hideSplashThenShowMain);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Renderer console output (including CSP violations and preload errors)
  // surfaced to the main process log -- otherwise it's invisible outside
  // devtools, which nobody has open on an end user's machine.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[renderer] failed to load: ${errorDescription} (${errorCode})`);
    diagnostics?.error('renderer_load_failed', { errorCode, errorDescription });
  });
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error(`[preload] error in ${preloadPath}:`, error);
    diagnostics?.error('preload_error', { message: error?.message });
  });
  // The renderer process crashing/being killed (OOM, GPU crash, ...) --
  // distinct from did-fail-load (a navigation failure). Logged so a crash
  // report from a user can be correlated with what the app was doing.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[renderer] process gone:', details?.reason);
    diagnostics?.error('renderer_crash', { reason: details?.reason, exitCode: details?.exitCode });
  });
}

function buildAppMenu() {
  const template = [
    {
      label: 'BQI',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Şimdi Senkronize Et', click: () => performSync().catch(() => {}) },
        { type: 'separator' },
        { role: 'quit', label: 'Çıkış' },
      ],
    },
    { label: 'Düzen', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload' },
        // DevTools exposes the renderer's full JS console/network/storage
        // inspector -- fine for development, but a production install must
        // not hand every user a live debugger into an app that holds
        // decrypted session data in memory. Uses the same isDev gate as
        // the rest of this file's dev-only branches (main.js's update-check
        // skip, the production-only load-path branch).
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  diagnostics = createDiagnostics(app.getPath('userData'));
  diagnostics.info('app_start', { version: app.getVersion(), platform: process.platform, isDev });

  // Baseline CSP for the desktop shell (the web deploy leaves this off
  // pending a dedicated audit -- see server/src/index.js's comment; this is
  // scoped to only the Electron BrowserWindow's own session, so it can't
  // affect the web app).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // connect-src used to allow the bare `wss:`/`ws:` schemes -- CSP
        // treats a scheme-only source as "any host over that scheme," so a
        // compromised renderer (XSS) could open a WebSocket to literally
        // any attacker-controlled wss:// endpoint and exfiltrate data,
        // which is exactly what connect-src is supposed to prevent. Scoped
        // to CLOUD_URL's own origin instead -- the only WebSocket endpoint
        // (Socket.IO) this app ever legitimately connects to.
        'Content-Security-Policy': [
          "default-src 'self' " + CLOUD_URL + "; connect-src 'self' " + CLOUD_URL + " " + CLOUD_WS_URL + "; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'",
        ],
      },
    });
  });

  // BQI-002: sensitive analyses fields (title/content) are encrypted at rest
  // with a key protected by safeStorage -- see db/dbKey.js/fieldCrypto.js.
  // getOrCreateKey() returns null (encrypting nothing, matching pre-BQI-002
  // behavior) on a platform/config where safeStorage isn't available,
  // rather than falling back to an insecure hardcoded key.
  const dbKeyStore = createDbKeyStore(app.getPath('userData'), safeStorage);
  db = openDatabase(path.join(app.getPath('userData'), 'bqi.db'), {
    onMigrations: (applied) => diagnostics.info('db_migrated', { applied: applied.length, files: applied }),
    encryptionKey: dbKeyStore.getOrCreateKey(),
  });
  // Points the local-llm provider's Model Manager at this install's real
  // userData dir instead of registry.js's ~/.bqi fallback (which
  // only exists so that module stays importable/testable without
  // Electron). No network access happens here -- this only resolves a
  // path and checks for an already-downloaded file (spec point 9).
  configureLocalLLM({ modelsDir: path.join(app.getPath('userData'), 'models') });
  deviceId = getOrCreateDeviceId(app.getPath('userData'));
  const secureStore = createSecureStore(app.getPath('userData'), safeStorage);
  sessionManager = createSessionManager({
    db, secureStore, deviceId, apiBaseUrl: CLOUD_URL,
    platform: process.platform, appVersion: app.getVersion(),
  });

  // Created once and kept alive for the life of the app (never recreated,
  // unlike before Offline Mode existed) -- appMode.js's set('offline')
  // needs to stop its polling without losing its last-known state (so
  // DesktopSyncBadge can still show a sensible badge), which only works if
  // the same instance survives a pause instead of being nulled out.
  connectivity = createConnectivityMonitor({ apiBaseUrl: CLOUD_URL });
  connectivity.onChange((state) => {
    diagnostics.info('connectivity_change', { state });
    mainWindow?.webContents.send('connectivity:change', state);
  });
  // A reconnect (local -> cloud) triggers an immediate sync instead of
  // waiting for the next timer tick -- spec point 3: sync starts
  // automatically the moment connectivity returns, with no user action.
  // onReconnect() (not the raw onChange()) is required here: it only fires
  // on a genuine local->cloud transition, not on performSync()'s own
  // sync->cloud settling step at the end of every sync pass -- see
  // connectivity.js's onReconnect doc comment for the infinite-loop bug
  // this previously caused (the sync status badge flickering constantly).
  connectivity.onReconnect(() => performSync().catch(() => {}));

  function startTimers() {
    // Periodic background sync in addition to the reconnect-triggered one
    // above, so a long-lived idle session with a flaky-but-technically-online
    // connection still eventually reconciles.
    syncTimer = setInterval(() => performSync().catch(() => {}), 5 * 60 * 1000);
    syncTimer.unref?.();

    if (!isDev && app.isPackaged) {
      // Checked via this app's own server (server/src/routes/version.js's
      // /generic/* feed), never GitHub directly -- see configureAutoUpdater.
      // Only surfaces a banner for the renderer to show -- nothing downloads
      // until the user approves it via the update:approve IPC handler above.
      // Failure here (no releases published yet, machine offline, ...) is
      // never fatal -- the app just runs the version it already has.
      checkAndBroadcastUpdate().catch(() => {});
      updateTimer = setInterval(() => checkAndBroadcastUpdate().catch(() => {}), 5 * 60 * 1000);
      updateTimer.unref?.();
    }
  }

  function stopTimersOnly() {
    if (syncTimer) clearInterval(syncTimer);
    if (updateTimer) clearInterval(updateTimer);
    syncTimer = null;
    updateTimer = null;
  }

  // Pauses the timers + connectivity polling without discarding
  // connectivity's last-known state -- used both as appMode's stopTimers
  // callback (Offline Mode) and by window-all-closed below, so a device
  // reawakened via 'activate' (or Offline Mode turned back off) always has
  // a live connectivity instance to resume rather than needing to rebuild
  // one from scratch.
  function pauseBackgroundServices() {
    stopTimersOnly();
    connectivity?.stop();
    backgroundServicesRunning = false;
  }

  // macOS keeps the app process alive after all windows close (see
  // window-all-closed below), which also pauses this -- 'activate' (the
  // dock-icon reopen) used to only recreate the window and left sync/
  // connectivity dead for the rest of that run, silently, until the app was
  // fully quit and relaunched. Wrapped in one function so both the initial
  // boot and every later reopen start it the same way.
  function startBackgroundServices() {
    // Persisted Offline Mode from a previous run -- stay paused rather than
    // start polling/syncing just to have appMode's own guard immediately
    // no-op every call; performSync()'s own top-of-function isOffline()
    // check is belt-and-suspenders for the handlers that call it directly,
    // not a substitute for not starting the timers at all.
    if (appMode.isOffline()) return;
    connectivity.start();
    performSync().catch(() => {});
    startTimers();
    backgroundServicesRunning = true;
  }

  appMode = createAppModeController({
    userDataDir: app.getPath('userData'),
    connectivity,
    performSync,
    getNeedsReauth: () => sessionManager.needsReauth(),
    // Wrapped rather than passing the bare functions: appMode.js's own
    // set('auto')/set('offline') already call connectivity.start()/
    // performSync()/startTimers() (or pauseBackgroundServices) directly,
    // bypassing startBackgroundServices() entirely -- without also flipping
    // this flag here, app.on('activate')'s `if (!backgroundServicesRunning)`
    // check below would think services were still stopped after switching
    // back to Otomatik and call startBackgroundServices() again on the next
    // dock-reopen, doubling up connectivity's poll interval and the sync/
    // update timers (createConnectivityMonitor's start() has no
    // already-running guard of its own).
    startTimers: () => { startTimers(); backgroundServicesRunning = true; },
    stopTimers: pauseBackgroundServices,
    sendReauthRequired: () => mainWindow?.webContents.send('auth:reauthRequired'),
    broadcastConnectivity: (state) => mainWindow?.webContents.send('connectivity:change', state),
    apiBaseUrl: CLOUD_URL,
  });

  configureAutoUpdater();
  registerIpcHandlers();
  buildAppMenu();
  createSplashWindow();
  await createWindow();
  startBackgroundServices();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    // window-all-closed (macOS branch) paused these -- restart them any
    // time we're reopening from that paused state, not just on cold boot.
    if (!backgroundServicesRunning) startBackgroundServices();
  });

  app.on('window-all-closed', () => {
    pauseBackgroundServices();
    if (process.platform !== 'darwin') app.quit();
  });
});
