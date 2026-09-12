// App-wide "Offline Mode" preference (Settings > Bağlantı) -- distinct from
// localModePreference.js's forceLocalMode, which only steers analysis/
// consult requests to the local AI engine. This preference is broader: it
// also gates Socket.IO, the update check, the weather widget, and passkey
// management (see the various gating call sites in DashboardPage.jsx,
// EmergencyChatPanel.jsx, AnalysisView.jsx, ConsultChat.jsx, UpdateBanner.jsx
// and AppMenus.jsx's SecurityPanel). Mirrors localModePreference.js's exact
// shape: localStorage-backed + CustomEvent pub/sub.
//
// IMPORTANT: this module must stay fully independent of offline login
// (desktop/auth/session.js and client/src/mobile/auth/session.js). Those
// modules must never import or read this one -- offline-login authorization
// and this manual "Offline Mode" toggle are separate concepts, and wiring
// them together would make a user's app-mode choice affect whether they can
// log in at all, which is not the intent.
const KEY = 'bqi_app_mode';
const EVENT = 'bqi:app-mode-change';
const VALID_MODES = new Set(['auto', 'offline']);

// v3.2.0 briefly persisted {deviceId,jwt} for an offline "Bu Cihazı Unut"
// operation in renderer localStorage under this key. v3.2.1 moves that
// pending revoke into the platform encrypted auth store and never exports
// the bearer token to the renderer. Remove the legacy key eagerly on module
// load so upgrading users do not keep an old plaintext JWT indefinitely.
const LEGACY_PENDING_DEVICE_REVOKE_KEY = 'bqi_pending_device_revoke';

function storage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
}

try {
  storage()?.removeItem(LEGACY_PENDING_DEVICE_REVOKE_KEY);
} catch {}

export function getAppMode() {
  try {
    const stored = storage()?.getItem(KEY);
    return VALID_MODES.has(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function isAppModeOffline() {
  return getAppMode() === 'offline';
}

export function setAppMode(mode) {
  if (!VALID_MODES.has(mode)) return getAppMode();
  try {
    storage()?.setItem(KEY, mode);
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { mode } }));
  }
  return mode;
}

export function subscribeAppModePreference(callback) {
  if (typeof window === 'undefined') return () => {};
  const handler = (event) => callback(event?.detail?.mode || 'auto');
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
