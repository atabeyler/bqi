const KEY = 'bqi_force_local_mode';
const EVENT = 'bqi:force-local-mode-change';

function storage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
}

export function isLocalModeForced() {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setLocalModeForced(forced) {
  const next = !!forced;
  try {
    if (next) storage()?.setItem(KEY, '1');
    else storage()?.removeItem(KEY);
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { forced: next } }));
  }
  return next;
}

export function subscribeLocalModePreference(callback) {
  if (typeof window === 'undefined') return () => {};
  const handler = (event) => callback(!!event?.detail?.forced);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
