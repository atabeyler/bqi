import { EventEmitter } from 'node:events';

// Tri-state connectivity: 'cloud' (reachable, idle), 'sync' (a push/pull is
// actively running), 'local' (unreachable — desktop keeps working against
// SQLite only). This module only ever reports state via events; it never
// touches the window or the session, so losing connectivity can't tear down
// the UI or kick the user out (spec point 6).
export function createConnectivityMonitor({ apiBaseUrl, fetchImpl = fetch, intervalMs = 30000 }) {
  const emitter = new EventEmitter();
  let state = 'local';
  let previousState = 'local';
  let timer = null;

  function setState(next) {
    if (next === state) return;
    previousState = state;
    state = next;
    emitter.emit('change', state);
  }

  async function checkOnce() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetchImpl(`${apiBaseUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      setState(res.ok ? 'cloud' : 'local');
      return res.ok;
    } catch {
      setState('local');
      return false;
    }
  }

  // The sync engine calls this while a push/pull is actively in flight, so
  // the UI can show "SYNC" instead of just "Q CLOUD" during that window;
  // the next periodic checkOnce() (or an explicit one after the sync pass)
  // settles it back to 'cloud' or 'local'.
  function markSyncing() {
    setState('sync');
  }

  function start() {
    checkOnce();
    timer = setInterval(checkOnce, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Fires only on a genuine local -> cloud transition (the connection was
  // actually down and just came back), not on every arrival at 'cloud' --
  // markSyncing()'s 'sync' state sits between them during a normal sync
  // pass (cloud -> sync -> cloud), and treating that final sync -> cloud
  // step as "reconnected" too previously caused an infinite loop in
  // main.js: the reconnect handler called performSync(), whose own
  // checkOnce() at the end set state back to 'cloud', which re-fired the
  // same reconnect handler, forever -- visible in the UI as the sync badge
  // (DesktopSyncBadge.jsx) flickering constantly between SYNC and Q CLOUD.
  function onReconnect(fn) {
    return onChange((next) => {
      if (next === 'cloud' && previousState === 'local') fn(next);
    });
  }

  function onChange(fn) {
    emitter.on('change', fn);
    return () => emitter.off('change', fn);
  }

  return {
    start,
    stop,
    checkOnce,
    markSyncing,
    getState: () => state,
    onChange,
    onReconnect,
    offChange: (fn) => emitter.off('change', fn),
  };
}
