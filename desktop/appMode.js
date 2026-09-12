import fs from 'node:fs';
import path from 'node:path';

// Persists { mode: 'auto' | 'offline' } -- mirrors auth/deviceId.js's exact
// read/write pattern. There is no generic settings store (no electron-store
// dependency) in this repo, so a small dedicated JSON file is the minimal
// addition for the one setting Offline Mode needs to survive a restart.
const MODE_FILE_NAME = 'app-mode.json';

// v3.2.0 briefly stored {deviceId,jwt} here as plaintext JSON when
// "Bu Cihazı Unut" happened in Manual Offline Mode. v3.2.1 moves pending
// revoke state into auth/session.js's OS-encrypted secureStore and uses the
// next successful online login's fresh JWT instead. Keep the name only so
// upgrades can proactively delete that legacy bearer-token file.
const LEGACY_PENDING_REVOKE_FILE_NAME = 'pending-device-revoke.json';

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Corrupt file -- treat as absent rather than crash the app over a
    // small local settings cache (same defensive pattern as deviceId.js).
    return null;
  }
}

function writeJsonSafe(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// createAppModeController -- the renderer -> main IPC bridge backing for
// the desktop "Offline Mode" toggle (Settings > Bağlantı). A small
// testable factory mirroring connectivity.js's createConnectivityMonitor
// style: every Electron-only or process-wide dependency (broadcasting to
// the renderer, starting/stopping main.js's sync & update timers, running
// a sync pass) is injected rather than imported, so this is unit-testable
// without a real Electron process.
export function createAppModeController({
  userDataDir,
  connectivity,
  performSync,
  getNeedsReauth,
  startTimers,
  stopTimers,
  sendReauthRequired = () => {},
  broadcastConnectivity = () => {},
}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const modeFile = path.join(userDataDir, MODE_FILE_NAME);
  const legacyRevokeFile = path.join(userDataDir, LEGACY_PENDING_REVOKE_FILE_NAME);

  // Security migration: remove any v3.2.0 plaintext pending revoke as soon
  // as the controller is created. A stale bearer token must not survive an
  // upgrade merely because the user never toggles Offline Mode again.
  try { fs.rmSync(legacyRevokeFile, { force: true }); } catch {}

  let mode = readJsonSafe(modeFile)?.mode === 'offline' ? 'offline' : 'auto';

  function get() {
    return mode;
  }

  function isOffline() {
    return mode === 'offline';
  }

  // Kept as a compatibility no-op because desktop/main.js from the same
  // release line may still call appMode.setPendingRevoke(result...). The
  // new session manager deliberately always returns pendingServerRevoke:null
  // and retains only a non-sensitive tombstone inside secureStore, so this
  // method must never persist credentials again.
  function setPendingRevoke() {}

  // The reconciliation sequence for coming back to 'auto': resume
  // connectivity polling, check once immediately (rather than waiting up
  // to intervalMs for the next tick), bail out to a reauth prompt if the
  // cached session has expired (matching performSync()'s own check),
  // otherwise sync once, restart the periodic timers, and push the fresh
  // connectivity state to the renderer. A pending device revoke no longer
  // lives here; auth/session.js settles it with the next fresh online JWT.
  async function reconcileAuto() {
    connectivity.start();
    await connectivity.checkOnce();
    if (getNeedsReauth()) {
      sendReauthRequired();
    } else {
      await performSync().catch(() => {});
    }
    startTimers();
    broadcastConnectivity(connectivity.getState());
  }

  async function set(next) {
    if (next !== 'auto' && next !== 'offline') return mode;
    mode = next;
    writeJsonSafe(modeFile, { mode });
    if (next === 'offline') {
      // Belt-and-suspenders alongside performSync()'s own top-of-function
      // guard (main.js) -- stops the timers/polling that would otherwise
      // call it again within minutes.
      stopTimers();
      return mode;
    }
    try {
      await reconcileAuto();
    } catch {
      // Best-effort -- the mode itself is already persisted as 'auto'
      // above regardless of whether this one reconciliation pass fully
      // succeeded; the next periodic sync/connectivity tick gets another
      // attempt.
    }
    return mode;
  }

  return { get, set, isOffline, setPendingRevoke };
}
