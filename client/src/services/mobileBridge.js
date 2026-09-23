import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { SQLiteConnection, CapacitorSQLite } from '@capacitor-community/sqlite';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';

import { openDatabase } from '../mobile/db/index.js';
import { createDbKeyStore } from '../mobile/db/dbKey.js';
import { setEncryptionKey } from '../mobile/db/fieldCrypto.js';
import { listAnalyses, getAnalysis, createAnalysis, updateAnalysis, deleteAnalysis } from '../mobile/db/analysesRepo.js';
import { getOrCreateDeviceId } from '../mobile/auth/deviceId.js';
import { createSecureStore } from '../mobile/auth/secureStore.js';
import { createSessionManager } from '../mobile/auth/session.js';
import { runSync } from '../mobile/sync/engine.js';
import { listUnresolvedConflicts, resolveConflict } from '../mobile/sync/conflict.js';
import { createLocalAIProvider } from '../mobile/localAI/provider.js';
import { getModelManager, refreshInstalledState, setModelTier, listModelTiers } from '../mobile/localAI/registry.js';
import { createDiagnostics } from '../mobile/diagnostics.js';
import { getCurrentUser } from './api.js';
import { isAppModeOffline, subscribeAppModePreference } from './appModePreference.js';

// Android (Capacitor) equivalent of desktopBridge.js -- same exported API
// shape (auth/analyses/sync/ai/connectivity) so the UI layer can treat both
// platforms uniformly via nativeBridge.js. Unlike Electron there is no
// separate main process/IPC boundary here: this module *is* the "native"
// side, running in the same WebView JS context as the rest of the app, and
// calls the Capacitor plugins directly.
export const isMobileApp = Capacitor.isNativePlatform();

// Static for the life of the app -- used by HistoryView.jsx's device label,
// mirrors desktopBridge.js's desktopPlatform.
export const mobilePlatform = isMobileApp ? Capacitor.getPlatform() : null;

// The deployed web app is the source of truth this points at by default;
// override at build time with VITE_MOBILE_CLOUD_URL for a self-hosted/
// staging server (see mobile/README.md).
const CLOUD_URL = import.meta.env.VITE_MOBILE_CLOUD_URL || 'https://bqi.onrender.com';

// api.js reads this to know where the "same-origin" API actually lives --
// the WebView's own origin (capacitor://localhost) has no API on it.
if (typeof window !== 'undefined' && isMobileApp) {
  window.bqiMobile = { isMobileApp: true, cloudUrl: CLOUD_URL, platform: Capacitor.getPlatform() };
}

let dbPromise = null;
let diagnosticsPromise = null;
let sessionManagerPromise = null;
let deviceId = null;
let connectivityState = 'local';
const connectivityListeners = new Set();
const reauthListeners = new Set();


function getDb() {
  if (!dbPromise) {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    dbPromise = (async () => {
      const key = await createDbKeyStore(SecureStorage).getOrCreateKey();
      setEncryptionKey(key);
      return openDatabase(sqlite);
    })();
  }
  return dbPromise;
}

// Mirrors desktop/main.js's module-level `diagnostics` -- lazy instead of
// eager (there's no app.whenReady() equivalent here to create it upfront),
// but every call site below awaits this the same way it awaits getDb().
function getDiagnostics() {
  if (!diagnosticsPromise) diagnosticsPromise = getDb().then(createDiagnostics);
  return diagnosticsPromise;
}

async function getSessionManager() {
  if (!sessionManagerPromise) {
    sessionManagerPromise = (async () => {
      const db = await getDb();
      deviceId = getOrCreateDeviceId();
      const secureStore = createSecureStore(SecureStorage);
      return createSessionManager({
        db, secureStore, deviceId, apiBaseUrl: CLOUD_URL,
        platform: Capacitor.getPlatform(), appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
      });
    })();
  }
  return sessionManagerPromise;
}

async function currentUserId() {
  const session = await (await getSessionManager()).getSession();
  if (session?.userCode) return session.userCode;
  // Falls back to decoding the app's own JWT (already in localStorage
  // once logged in via the normal LoginPage flow) when nativeAuth's
  // separate secure-store session was never established -- e.g.
  // registerNativeSession()'s background /api/devices/register call
  // failed silently (LoginPage.jsx only warns to console; it never blocks
  // login). Without this fallback, a genuinely logged-in user (JWT
  // present, dashboard/wizard fully working) could still see every local
  // AI query -- including the always-available offline-extractive
  // fallback -- fail with "Oturum açılmamış", masked upstream by
  // analysisRouter.js's AllEnginesUnavailableError as a generic "no
  // engine available" message with no visible explanation.
  return getCurrentUser()?.userCode || null;
}

function setConnectivity(state) {
  if (state === connectivityState) return;
  connectivityState = state;
  connectivityListeners.forEach((fn) => fn(state));
  getDiagnostics().then((d) => d.info('connectivity_change', { state })).catch(() => {});
}

async function checkConnectivity() {
  // Offline Mode (Settings > Bağlantı) is a manual, user-asserted choice --
  // never probe the network to second-guess it, unlike the automatic
  // local/cloud detection below.
  if (isAppModeOffline()) { setConnectivity('local'); return connectivityState; }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${CLOUD_URL}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    setConnectivity(res.ok ? 'cloud' : 'local');
  } catch {
    setConnectivity('local');
  }
  return connectivityState;
}

async function performSync() {
  // Single choke point: every write-triggered sync (mobileAnalyses.
  // create/update/remove), mobileSync.forceSync/resolveConflict, and
  // establishOnlineSession's post-login sync all funnel through here, so
  // gating Offline Mode in one place covers all of them.
  if (isAppModeOffline()) return { ok: false, skipped: true };
  const manager = await getSessionManager();
  const session = await manager.getSession();
  if (!session) return;

  // A cached JWT past its own exp claim is a guaranteed 401 on every call
  // -- there's no server-side refresh-token endpoint to silently renew it
  // with, so skip the doomed network round-trip and tell the UI to prompt
  // for a fresh online login instead. Mirrors desktop/main.js's
  // performSync(). The sync queue and local data are untouched either way;
  // whatever is queued gets pushed automatically the moment
  // establishOnlineSession succeeds again (it already triggers a sync
  // right after).
  const diagnostics = await getDiagnostics();
  if (await manager.needsReauth()) {
    diagnostics.warn('reauth_required', {});
    reauthListeners.forEach((fn) => fn());
    return { ok: false, error: 'reauth_required', reauthRequired: true };
  }

  setConnectivity('sync');
  diagnostics.info('sync_start', {});
  const db = await getDb();
  let result;
  try {
    result = await runSync(db, { apiBaseUrl: CLOUD_URL, getToken: () => session.jwt, deviceId, userId: session.userCode });
  } catch (err) {
    diagnostics.error('sync_failed', { message: err.message });
    throw err;
  }
  if (result?.ok === false) {
    diagnostics.warn('sync_failed', { message: result.error });
  } else {
    diagnostics.info('sync_success', {
      pushed: result?.push?.pushed ?? 0,
      pulled: result?.pull?.pulled ?? 0,
    });
    const conflicts = result?.push?.conflicts ?? 0;
    if (conflicts > 0) diagnostics.warn('sync_conflict', { count: conflicts });
  }
  await checkConnectivity();
  return result;
}

// Every exported method below no-ops (mirrors desktopBridge.js's `bridge?.`
// optional-chaining) unless actually running as the installed Android app --
// on the web build (or a hypothetical iOS build), nothing here ever touches
// SQLite/secure-storage/Capacitor plugins at all.
function guard(fn) {
  return (...args) => (isMobileApp ? fn(...args) : undefined);
}

export const mobileAuth = {
  establishOnlineSession: guard(async (jwt, password) => {
    const result = await (await getSessionManager()).establishOnlineSession(jwt, password);
    performSync().catch(() => {});
    return result;
  }),
  verifyOfflineLogin: guard(async (userCode, password) => (await getSessionManager()).verifyOfflineLogin(userCode, password)),
  getSession: guard(async () => (await getSessionManager()).getSession()),
  // deviceId (module-level above) is only populated once getSessionManager()
  // has actually run at least once -- awaiting it here guarantees that
  // without requiring every caller (just HistoryView.jsx's device label, for
  // now) to know that detail.
  getDeviceId: guard(async () => { await getSessionManager(); return deviceId; }),
  isOfflineLoginAllowed: guard(async (userCode) => (await getSessionManager()).isOfflineLoginAllowed(userCode)),
  needsReauth: guard(async () => (await getSessionManager()).needsReauth()),
  // Always returns a real (safely no-op-able) unsubscribe function, even on
  // web/desktop where the callback is simply never added -- matches
  // mobileConnectivity.onChange's shape below.
  onReauthRequired: (callback) => {
    if (!isMobileApp) return () => {};
    reauthListeners.add(callback);
    return () => reauthListeners.delete(callback);
  },
  logoutSession: guard(async () => (await getSessionManager()).logoutSession()),
  // Pending server revocation is owned entirely by the encrypted session
  // manager. Renderer localStorage never receives a bearer token or revoke debt.
  forgetDevice: guard(async () =>
    (await getSessionManager()).forgetDevice({ allowNetwork: !isAppModeOffline() })
  ),
};

export const mobileAnalyses = {
  list: guard(async () => {
    const userId = await currentUserId();
    return userId ? listAnalyses(await getDb(), userId) : [];
  }),
  get: guard(async (id) => {
    const userId = await currentUserId();
    return userId ? getAnalysis(await getDb(), userId, id) : null;
  }),
  create: guard(async (data) => {
    const userId = await currentUserId();
    if (!userId) throw new Error('not_logged_in');
    // userId/deviceId are session-derived and must win over any same-named
    // key in the caller's data object -- spreading data first (not last)
    // is what makes that override impossible. Matches desktop/main.js's
    // analyses:create IPC handler, which has the same fix for the same
    // reason (there, across an actual Electron IPC trust boundary).
    const row = await createAnalysis(await getDb(), { ...data, userId, deviceId });
    performSync().catch(() => {});
    return row;
  }),
  update: guard(async (id, data) => {
    const userId = await currentUserId();
    if (!userId) throw new Error('not_logged_in');
    const row = await updateAnalysis(await getDb(), { ...data, userId, deviceId, id });
    performSync().catch(() => {});
    return row;
  }),
  remove: guard(async (id) => {
    const userId = await currentUserId();
    if (!userId) throw new Error('not_logged_in');
    const removed = await deleteAnalysis(await getDb(), { userId, deviceId, id });
    performSync().catch(() => {});
    return removed;
  }),
};

export const mobileSync = {
  status: guard(async () => ({ state: connectivityState, deviceId })),
  forceSync: guard(() => performSync()),
  listConflicts: guard(async () => listUnresolvedConflicts(await getDb())),
  resolveConflict: guard(async (conflictId, resolution) => {
    const resolved = await resolveConflict(await getDb(), { conflictId, deviceId, resolution });
    if (resolved) performSync().catch(() => {});
    return resolved;
  }),
};

export const mobileAI = {
  query: guard(async (request) => {
    const userId = await currentUserId();
    if (!userId) return { ok: false, error: 'not_logged_in' };
    return createLocalAIProvider({ db: await getDb(), userId, diagnostics: await getDiagnostics() }).query(request);
  }),
  // Model Manager surface -- mirrors desktopAI's, and is wired into the
  // same Settings > Local AI panel (components/LocalAIPanel.jsx) via
  // nativeBridge.js. On Android, isAvailable() also depends on the native
  // LocalLLM plugin (see mobile/localAI/llmRuntime.js and
  // mobile/android/app/src/main/java/.../localllm/).
  modelStatus: guard(async () => {
    const mm = getModelManager();
    const installed = await refreshInstalledState();
    return { installed, capability: mm.checkCapability(), spec: mm.spec };
  }),
  modelDownload: guard(async (onProgress) => {
    const mm = getModelManager();
    try {
      const result = await mm.downloadModel({ onProgress });
      await refreshInstalledState();
      return { ok: true, ...result };
    } catch (err) {
      if (err.cancelled) return { ok: false, cancelled: true };
      return { ok: false, error: err.message };
    }
  }),
  // "Durdur" (deletePartial: false) pauses the in-flight download while
  // keeping the partial file for the next Range-resumed attempt; "İptal"
  // (deletePartial: true) also deletes it. Either way the pending
  // modelDownload() call above settles (rejects) on its own once the
  // aborted fetch actually stops -- this only signals it.
  modelDownloadCancel: guard(async (options) => getModelManager().cancelDownload(options)),
  modelRemove: guard(async () => {
    const result = await getModelManager().removeModel();
    await refreshInstalledState();
    return result;
  }),
  // Manual tier picker (Settings > Local AI): list the pinned tiers, then
  // repoint the registry's modelManager at the chosen one. Mirrors
  // desktopAI's ai:modelTiers/ai:modelSelectTier IPC pair -- see that
  // module's comment for why the renderer removes the old model first.
  modelTiers: guard(async () => listModelTiers()),
  modelSelectTier: guard(async (tier) => {
    try {
      setModelTier(tier);
      const installed = await refreshInstalledState();
      const mm = getModelManager();
      return { ok: true, installed, capability: mm.checkCapability(), spec: mm.spec };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }),
};

// Numeric dotted-version compare (2.1.9 < 2.1.10) -- lexical comparison
// would get that wrong. Android still compares versions itself against
// GET /api/version/latest (desktop's equivalent check now goes through
// electron-updater's own feed instead, see desktop/main.js), so this has
// no Node/Electron-main counterpart to import from anymore.
function isNewerVersion(latestVersion, currentVersion) {
  const a = latestVersion.split('.').map(Number);
  const b = currentVersion.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Converts an ArrayBuffer to base64 in fixed-size chunks -- String.fromCharCode(...bytes)
// on the whole ~15MB APK in one call blows the JS engine's argument-count/call-stack
// limit on some WebViews. 32KB keeps each intermediate string small.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function sha256Hex(buffer) {
  if (!crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const mobileUpdate = {
  // Checked via this app's own server (server/src/routes/version.js), never
  // GitHub's API directly -- see that route's comment. Logged on failure
  // (network not up yet at cold start, server 502 from an unauthenticated
  // GitHub rate limit, ...) so a silently-never-shown banner is at least
  // diagnosable -- UpdateBanner.jsx retries this on an interval so one
  // failed attempt doesn't mean no update banner for the whole session.
  check: guard(async () => {
    // Independent of UpdateBanner.jsx's own Offline Mode gate -- this is an
    // online-only service, so any other/future caller must not hit the
    // network while the user has manually gone offline either.
    if (isAppModeOffline()) return null;
    try {
      const res = await fetch(`${CLOUD_URL}/api/version/latest`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        getDiagnostics().then((d) => d.warn('update_check_failed', { status: res.status })).catch(() => {});
        return { available: false };
      }
      const info = await res.json();
      const apk = info.assets?.androidApk;
      const current = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
      if (!info.version || !apk?.url || !current || !isNewerVersion(info.version, current)) return { available: false };
      return { available: true, version: info.version, notes: info.notes, url: apk.url, sha256: apk.sha256 || null };
    } catch (err) {
      getDiagnostics().then((d) => d.warn('update_check_failed', { message: err?.message })).catch(() => {});
      return { available: false };
    }
  }),
  // Downloads the APK ourselves and hands the local file straight to the
  // system package installer via a FileProvider content:// intent, instead
  // of the old window.open(url, '_system') which routed the download
  // through Chrome -- Chrome's Safe Browsing flags any downloaded .apk with
  // its own "may be harmful" warning, on top of (and before) Android's own
  // unknown-sources install prompt, which looked broken/untrustworthy to
  // users. This path only triggers Android's own, expected install prompt.
  // Android still requires an explicit tap to install (no Play-Store-style
  // silent auto-install), so this hands off to the OS installer rather than
  // completing the update itself.
  approve: guard(async (url, expectedSha256 = null) => {
    if (isAppModeOffline()) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`APK indirilemedi (${res.status})`);
    const buffer = await res.arrayBuffer();
    if (expectedSha256) {
      const actualSha256 = await sha256Hex(buffer);
      if (actualSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
        throw new Error('APK doğrulaması başarısız');
      }
    }
    const data = arrayBufferToBase64(buffer);
    const path = 'bqi-update.apk';
    await Filesystem.writeFile({ path, data, directory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await FileOpener.open({ filePath: uri, contentType: 'application/vnd.android.package-archive' });
  }),
};

// Wraps the native @capacitor/geolocation plugin (see AndroidManifest.xml's
// ACCESS_FINE_LOCATION/ACCESS_COARSE_LOCATION comment) so DashboardPage.jsx's
// live-location sharing can request location natively on Android instead of
// through the WebView's own navigator.geolocation. The plain web API
// triggers the WebView's per-origin geolocation prompt, which shows this
// app's raw hosting URL instead of its name -- going through the native
// plugin instead makes Android show its own OS permission dialog (app name
// + icon) the same way any other native Android app's location prompt does.
export const mobileGeolocation = {
  // Mirrors navigator.geolocation.watchPosition's shape closely enough for
  // a caller to swap between the two (see DashboardPage.jsx): takes a
  // callback given the position's coords, returns an unsubscribe function
  // instead of a numeric watch ID, since callers already need a cleanup
  // function shape for their effect's return value.
  watchPosition: (onCoords, options = {}) => {
    if (!isMobileApp) return () => {};
    let watchId = null;
    let cancelled = false;
    Geolocation.watchPosition(options, (position) => {
      if (position?.coords) onCoords(position.coords);
    }).then((id) => {
      if (cancelled) { Geolocation.clearWatch({ id }).catch(() => {}); return; }
      watchId = id;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (watchId) Geolocation.clearWatch({ id: watchId }).catch(() => {});
    };
  },
};

export const mobileConnectivity = {
  getState: guard(async () => connectivityState),
  // Always returns a real (safely no-op-able) unsubscribe function, even on
  // web/desktop where the callback is simply never added -- callers rely on
  // being able to invoke whatever onChange() gives back.
  onChange: (callback) => {
    if (!isMobileApp) return () => {};
    connectivityListeners.add(callback);
    return () => connectivityListeners.delete(callback);
  },
};

// Bootstraps as soon as this module loads, if actually running as the
// installed Android app -- mirrors desktop/main.js's app.whenReady()
// sequence, just inline since there's no separate main process here.
if (isMobileApp) {
  getDiagnostics().then((d) => d.info('app_start', {
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    platform: Capacitor.getPlatform(),
  })).catch(() => {});
  checkConnectivity();
  setInterval(checkConnectivity, 30000);
  // Populates the local-llm provider's cached "is a model installed" flag
  // (registry.js's isModelInstalled() is async, but selectProvider()'s
  // isAvailable() must stay synchronous -- see registry.js's comment).
  // Filesystem-only, no network call.
  refreshInstalledState().catch(() => {});
  // A reconnect (local -> cloud) triggers an immediate sync instead of
  // waiting for the periodic timer below (spec point 3).
  connectivityListeners.add((state) => { if (state === 'cloud') performSync().catch(() => {}); });
  setInterval(() => performSync().catch(() => {}), 5 * 60 * 1000);
  // Both setIntervals above keep running unchanged while Offline Mode is on
  // -- checkConnectivity/performSync are now internally no-ops in that case
  // (see their own guards), so there's no need to pause/resume the timers
  // themselves. This listener only closes the gap between a mode flip and
  // the next poll: offline -> immediate 'local' instead of waiting up to
  // 30s, auto -> immediate reconcile instead of waiting up to 30s. The encrypted session manager, not this mode listener, owns any pending device revoke.
  subscribeAppModePreference((mode) => {
    if (mode === 'offline') {
      setConnectivity('local');
      return;
    }
    checkConnectivity();
  });
}
