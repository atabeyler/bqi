// Detects whether the browser was actually closed (all tabs gone for a
// while) versus this being just a page refresh or an additional tab opened
// alongside one that's already open -- there is no reliable, synchronous
// "the browser just closed" event in a web page (beforeunload/pagehide fire
// identically for a refresh, a same-tab navigation, and a real close, and
// none of them fire at all on a crash or force-quit), so this uses the one
// signal that *is* reliable: whether any tab has written a heartbeat to
// localStorage recently. As long as one tab of an authenticated session
// stays open, the heartbeat never goes stale, so refreshing or opening a
// second tab never trips this. Once every tab has been closed for longer
// than STALE_AFTER_MS, the next tab to open is treated as a fresh session.
const HEARTBEAT_KEY = 'bqi_tab_heartbeat';
const HEARTBEAT_INTERVAL_MS = 5000;
// Deliberately generous rather than "instant": background-tab timer
// throttling in modern browsers can delay a hidden tab's own interval by
// several seconds, and too tight a window would false-positive a still-open
// (but backgrounded) tab as "browser closed" the moment a second tab opens.
// This is a real, practical trade-off, not a bug -- it shrinks the window
// during which a still-valid session cookie can be walked into by someone
// else from 2-4 HOURS (the cookie's own lifetime) down to well under a
// minute, which is what actually matters for the walk-away-from-your-desk
// threat this defends against.
const STALE_AFTER_MS = 25000;

let heartbeatTimer = null;

function writeHeartbeat() {
  try { localStorage.setItem(HEARTBEAT_KEY, String(Date.now())); } catch { /* private mode / storage disabled */ }
}

// Call once an authenticated session is confirmed in this tab; call
// stopTabHeartbeat() on logout so a logged-out tab stops vouching for the
// session's continued presence.
export function startTabHeartbeat() {
  writeHeartbeat();
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
}

export function stopTabHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// True when no tab has proven itself "open" recently enough -- i.e. every
// tab of this browser was actually closed (or none ever logged in here).
// Fails open (returns false) on a localStorage read error rather than
// locking a legitimate user out over a private-mode/storage quirk.
export function wasBrowserFullyClosedRecently() {
  try {
    const last = Number(localStorage.getItem(HEARTBEAT_KEY));
    if (!last) return true;
    return Date.now() - last > STALE_AFTER_MS;
  } catch {
    return false;
  }
}
