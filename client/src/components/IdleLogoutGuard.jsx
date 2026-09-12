import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLang } from '../services/langContext.jsx';

const IDLE_LIMIT_MS = 15 * 60 * 1000;
const WARNING_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 1000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'];

// The real vulnerability this closes: a user steps away from an unlocked
// device without clicking "Log out" -- the session cookie/JWT (server/src/
// lib/cookies.js, 2-4h maxAge) stays valid for hours regardless, so anyone
// who sits down at that still-open tab is fully authenticated as them.
// Reducing the cookie's own lifetime doesn't fix this (it would just force
// re-logins during active use); the actual fix is ending the session on
// inactivity, independent of how much of the cookie's total lifetime is
// left. Runs the exact same teardown as the header's own logout button
// (services/fullLogout.js) so a kiosk/shared device is left exactly as
// clean as a manual logout would.
export default function IdleLogoutGuard({ onIdleLogout }) {
  const { t } = useLang();
  const lastActivityRef = useRef(Date.now());
  const [remainingMs, setRemainingMs] = useState(null); // null = no warning showing

  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
      setRemainingMs(null);
    };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));

    // A backgrounded tab regaining focus after a long stretch is not
    // activity by itself -- it must still be checked against the same
    // limit, otherwise switching back to a stale tab (e.g. after lunch)
    // would silently keep the session alive with no warning at all.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivityRef.current >= IDLE_LIMIT_MS) onIdleLogout();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const interval = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor >= IDLE_LIMIT_MS) {
        setRemainingMs(null);
        onIdleLogout();
      } else if (idleFor >= IDLE_LIMIT_MS - WARNING_MS) {
        setRemainingMs(IDLE_LIMIT_MS - idleFor);
      } else {
        setRemainingMs(null);
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, markActive));
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, [onIdleLogout]);

  if (remainingMs === null) return null;

  return (
    <div className="fixed inset-0 z-[98] bg-black/70 flex items-center justify-center px-4">
      <div className="hud-panel rounded-xl p-6 max-w-sm w-full text-center space-y-4">
        <AlertTriangle className="w-8 h-8 text-gold mx-auto" />
        <h2 className="text-cyan-100 text-base tracking-wide">{t('idleLogoutWarningTitle')}</h2>
        <p className="text-cyan-100/70 text-sm">{t('idleLogoutWarningBody', { seconds: Math.max(1, Math.ceil(remainingMs / 1000)) })}</p>
        <button
          onClick={() => { lastActivityRef.current = Date.now(); setRemainingMs(null); }}
          className="bg-cyan-400/15 border border-cyan-300/50 text-cyan-100 px-4 py-2 rounded text-sm hover:bg-cyan-400/25"
        >
          {t('idleLogoutStayBtn')}
        </button>
      </div>
    </div>
  );
}
