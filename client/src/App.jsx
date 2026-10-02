import React, { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import LoginPage from './pages/LoginPage.jsx';
import GlobalVoiceAssistant from './components/GlobalVoiceAssistant.jsx';
import SplashScreen from './components/SplashScreen.jsx';
import QuantumLogo from './components/QuantumLogo.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import IdleLogoutGuard from './components/IdleLogoutGuard.jsx';
import { resolveCurrentUser, AUTH_CHANGED_EVENT, hydrateNativeSession } from './services/api.js';
import { fullLogout } from './services/fullLogout.js';
import { startTabHeartbeat, stopTabHeartbeat, wasBrowserFullyClosedRecently } from './services/tabPresence.js';
import { nativeAuth, isNativeApp } from './services/nativeBridge.js';
import { isDesktop, desktopAppMode } from './services/desktopBridge.js';
import { getAppMode, subscribeAppModePreference } from './services/appModePreference.js';
import { useLang } from './services/langContext.jsx';

// Shared by both loading gaps below (initial auth resolution, and the lazy
// route chunk boundary) -- a bare background color there used to render as
// an unexplained blank dark screen on a slow connection, easy to mistake
// for the app failing to load.
function LoadingFallback() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#060b16]">
      <QuantumLogo size="lg" />
      <div className="font-display text-cyan-100/75 text-xs tracking-[0.28em] uppercase">Bold Quantum Intelligence</div>
    </div>
  );
}

// The dashboard (and everything it pulls in -- analysis views, chat, voice,
// history, the 3D globe, etc.) made up the bulk of the single ~790KB main
// bundle; splitting it out means a first visit to /login only pays for the
// login page's own weight.
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const ButtonShowcasePage = lazy(() => import('./pages/ButtonShowcasePage.jsx'));
const CyberAnalysisPage = lazy(() => import('./pages/CyberAnalysisPage.jsx'));
const SfrePage = lazy(() => import('./pages/SfrePage.jsx'));

export default function App() {
  // undefined = still resolving who's logged in (web asks the server, since
  // the session lives in an httpOnly cookie no client JS can read; native
  // resolves this synchronously from its own stored JWT -- see
  // resolveCurrentUser()); null = confirmed logged out.
  const location = useLocation();
  const [user, setUser] = useState(undefined);
  // Every client surface, including an ordinary browser tab, gets the same
  // deterministic three-second branded launch. The dedicated BCI route owns
  // its own splash and is excluded so the two animations never stack.
  const [showSplash, setShowSplash] = useState(() => location.pathname !== '/cyber-analysis');
  const finishGlobalSplash = useCallback(() => setShowSplash(false), []);
  const showGlobalSplash = showSplash && location.pathname !== '/cyber-analysis';
  const { lang } = useLang();

  useEffect(() => {
    let alive = true;
    // Native's JWT now lives only in api.js's in-memory store (see its
    // setJWT/hydrateNativeSession comments) -- restore it from the platform's
    // secure session store before the first resolveCurrentUser() call, or
    // every launch would otherwise look logged-out until the next login.
    hydrateNativeSession(nativeAuth.getSession).then(async () => {
      // Web only: the session cookie itself stays valid for hours (see
      // server/src/lib/cookies.js) regardless of whether the tab/browser
      // that logged in is still open -- so on its own it would let anyone
      // who opens a brand-new tab days later walk straight into whoever
      // last used this browser with no password prompt. Ending that stale
      // server-side session the moment a genuinely fresh tab detects no
      // other tab is still open (see tabPresence.js) closes that window
      // down to well under a minute; native keeps its own separate
      // "remember this device" model untouched.
      let u;
      if (!isNativeApp && wasBrowserFullyClosedRecently()) {
        await fullLogout();
        u = null; // the session was just ended on purpose: go to the login screen. Resolving the user here could race the server-side logout and show a dashboard whose every request is then 401.
      } else {
        u = await resolveCurrentUser();
      }
      if (alive) setUser(u);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (isNativeApp || !user) return undefined;
    startTabHeartbeat();
    return () => stopTabHeartbeat();
  }, [user]);

  // Pushes the renderer's localStorage Offline Mode preference into
  // desktop/appMode.js's main-process copy -- appModePreference.js itself
  // stays platform-agnostic (no desktopBridge import), so this is the one
  // place that connects the two on desktop. The one-shot set() on mount
  // covers first run / an app version where main didn't know about
  // Offline Mode yet; the subscription covers the user flipping it live
  // from Settings > Bağlantı. Mobile needs none of this -- its "main" and
  // renderer share the same JS process (see mobileBridge.js), so isDesktop
  // gates it out entirely there.
  useEffect(() => {
    if (!isDesktop) return undefined;
    desktopAppMode.set(getAppMode());
    return subscribeAppModePreference((mode) => { if (isDesktop) desktopAppMode.set(mode); });
  }, []);

  // Event-driven instead of polling: setJWT() fires AUTH_CHANGED_EVENT on
  // login/logout in this tab, the browser fires 'storage' for other tabs
  // (native only -- web no longer writes bqi_jwt to localStorage), and
  // a one-shot timeout re-checks exactly at token expiry.
  useEffect(() => {
    if (user === undefined) return; // initial resolution above still in flight
    let alive = true;
    const sync = () => resolveCurrentUser().then((u) => { if (alive) setUser(u); });
    const onStorage = (e) => { if (!e.key || e.key === 'bqi_jwt') sync(); };
    // 'storage' only covers native (bqi_jwt in localStorage); the web
    // build's httpOnly-cookie session never writes that key, so other web
    // tabs need the BroadcastChannel api.js's setJWT() posts to instead.
    const authChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bqi-auth') : null;

    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    window.addEventListener('storage', onStorage);
    authChannel?.addEventListener('message', sync);

    let expiryTimer;
    if (user?.exp) {
      const msUntilExpiry = user.exp * 1000 - Date.now();
      // setTimeout delays beyond ~24.8 days overflow to fire immediately in
      // some engines; JWTs here expire in hours, but clamp defensively.
      if (msUntilExpiry > 0 && msUntilExpiry < 2 ** 31) {
        expiryTimer = setTimeout(sync, msUntilExpiry);
      }
    }

    return () => {
      alive = false;
      window.removeEventListener(AUTH_CHANGED_EVENT, sync);
      window.removeEventListener('storage', onStorage);
      authChannel?.close();
      if (expiryTimer) clearTimeout(expiryTimer);
    };
  }, [user]);

  // Still resolving on first load -- render nothing routable yet rather
  // than flashing /login for an already-logged-in web session.
  if (user === undefined) {
    return (
      <>
        {showGlobalSplash && <SplashScreen onComplete={finishGlobalSplash} />}
        <LoadingFallback />
      </>
    );
  }

  return (
    <>
      {showGlobalSplash && <SplashScreen onComplete={finishGlobalSplash} />}
      <UpdateBanner />
      {user && <IdleLogoutGuard onIdleLogout={() => { fullLogout(); setUser(null); }} />}
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage onLogin={setUser} />} />
          <Route path="/ui-buttons" element={user ? <ButtonShowcasePage /> : <Navigate to="/login" />} />
          <Route
            path="/cyber-analysis"
            element={
              user && (user.isAdmin || user.role === 'analyst') ? <CyberAnalysisPage user={user} /> : <Navigate to={user ? '/' : '/login'} />
            }
          />
          <Route
            path="/sfre"
            element={user && (user.isAdmin || user.role === 'analyst') ? <SfrePage user={user} /> : <Navigate to={user ? '/' : '/login'} />}
          />
          <Route path="/*" element={user ? <DashboardPage user={user} onLogout={() => setUser(null)} /> : <Navigate to="/login" />} />
        </Routes>
      </Suspense>
      <GlobalVoiceAssistant lang={lang} user={user} />
    </>
  );
}
