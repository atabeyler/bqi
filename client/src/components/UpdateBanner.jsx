import React, { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { isDesktop, desktopUpdate } from '../services/desktopBridge.js';
import { isMobileApp, mobileUpdate } from '../services/mobileBridge.js';
import { isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';

// Native-app-only (desktop + Android): checks this app's own server for a
// newer published version (never GitHub directly, see
// server/src/routes/version.js) and asks the user before doing anything.
// Desktop drives the whole download/install itself via IPC, backed by
// electron-updater (desktop/main.js's configureAutoUpdater); Android
// downloads the APK itself and hands it to
// the system package installer via a FileProvider intent (see
// mobileBridge.js's mobileUpdate.approve) rather than routing the download
// through Chrome. Renders nothing on the web build or once dismissed/no
// update found.
export default function UpdateBanner() {
  const [info, setInfo] = useState(null);
  const [stage, setStage] = useState('idle'); // idle | downloading | ready | error | dismissed
  const [progress, setProgress] = useState(null);
  const [dismissedVersion, setDismissedVersion] = useState(null);
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());

  useEffect(() => subscribeAppModePreference((mode) => setAppModeOffline(mode === 'offline')), []);
  const notesText = info?.notes
    ? info.notes
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\bgithub\.com\/\S+/gi, '')
        .replace(/\bgithub\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    : '';

  useEffect(() => {
    if (info?.version && info.version !== dismissedVersion && stage === 'dismissed') {
      setStage('idle');
      setDismissedVersion(null);
    }
  }, [info?.version, dismissedVersion, stage]);

  useEffect(() => {
    // Offline Mode (Settings > Connection): the update check is an online-only
    // service, so it's stopped entirely while the toggle is on -- no
    // immediate check, and no pending interval left running in the
    // background. Flipping back to Auto (appModeOffline -> false) re-runs
    // this effect and resumes checking normally.
    if (appModeOffline) return undefined;
    if (isDesktop) {
      let cancelled = false;
      (async () => {
        try {
          const result = await desktopUpdate.getAvailable?.();
          if (!cancelled && result?.version) setInfo(result);
        } catch {
          // The banner still works via the push event below; this is only a
          // best-effort startup recheck so a missing bridge method must not
          // crash the UI.
        }
      })();
      return desktopUpdate.onAvailable((result) => setInfo(result));
    }
    if (isMobileApp) {
      let cancelled = false;
      const runCheck = () => {
        mobileUpdate.check().then((result) => {
          if (!cancelled && result?.available) setInfo(result);
        });
      };
      // Mirrors desktop's checkAndBroadcastUpdate: an immediate check plus a
      // 5-minute retry interval (desktop/main.js), not just a single
      // best-effort attempt at mount -- a cold-start check can fail simply
      // because the network isn't up yet, and without a retry that meant no
      // banner for the rest of the session even once connectivity returned.
      runCheck();
      const intervalId = setInterval(runCheck, 5 * 60 * 1000);
      // The interval alone isn't enough on Android: the WebView commonly
      // throttles/suspends JS timers while backgrounded (screen lock,
      // switching apps, even briefly), so setInterval silently stalls and
      // never "catches up" -- observed firsthand: a release published while
      // the app sat open produced no banner at all until it was fully
      // quit and relaunched (which remounts this component and re-runs the
      // immediate check above), every time. visibilitychange is a standard
      // DOM event the WebView still fires on foreground/background
      // transitions (no extra Capacitor plugin needed), so re-checking
      // whenever the app becomes visible again closes that gap without
      // waiting for the next lucky interval tick.
      const onVisible = () => { if (document.visibilityState === 'visible') runCheck(); };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        cancelled = true;
        clearInterval(intervalId);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
    return undefined;
  }, [appModeOffline]);

  useEffect(() => {
    if (!isDesktop) return undefined;
    return desktopUpdate.onProgress(setProgress);
  }, []);

  if (!info || stage === 'dismissed') return null;

  const approve = async () => {
    if (isDesktop) {
      setStage('downloading');
      const result = await desktopUpdate.approve();
      setStage(result?.ok ? 'ready' : 'error');
    } else if (isMobileApp) {
      setStage('downloading');
      try {
        await mobileUpdate.approve(info.url, info.sha256);
        setStage('dismissed'); // Android's own install prompt takes over from here
      } catch {
        setStage('error');
      }
    }
  };

  const install = async () => {
    const result = await desktopUpdate.install();
    if (!result?.ok) setStage('error');
  };

  const pct = progress?.total ? Math.round((progress.received / progress.total) * 100) : null;

  if (isDesktop) {
    return (
      <div className="fixed inset-0 z-[97] flex items-center justify-center px-4 py-6 bg-slate-950/45 backdrop-blur-sm">
        <div className="w-full max-w-lg rounded-2xl border border-cyan-400/30 bg-slate-950/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] overflow-hidden">
          <div className="px-5 py-4 border-b border-cyan-400/20 bg-gradient-to-r from-cyan-950/90 to-slate-950/90 flex items-start gap-3">
            <Download className="w-5 h-5 shrink-0 text-cyan-300 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-[0.35em] text-cyan-200/80">Desktop Update</div>
              <div className="mt-1 text-base sm:text-lg text-cyan-50 font-medium">
                {stage === 'idle' && `A new version is available: v${info.version}`}
                {stage === 'downloading' && `Downloading${pct !== null ? ` (${pct}%)` : '...'}`}
                {stage === 'ready' && `v${info.version} downloaded.`}
                {stage === 'error' && 'Download failed.'}
              </div>
              {stage === 'idle' && notesText && (
                <p className="mt-2 text-xs sm:text-sm text-cyan-100/70 whitespace-pre-wrap">
                  {notesText}
                </p>
              )}
            </div>
            <button onClick={() => { setDismissedVersion(info.version); setStage('dismissed'); }} className="shrink-0 text-cyan-100/75 hover:text-cyan-50" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
            <div className="text-xs text-cyan-100/70 leading-5">
              {stage === 'idle' && 'The update downloads in the background -- you can keep working while it prepares to install.'}
              {stage === 'downloading' && 'Please wait until the download completes.'}
              {stage === 'ready' && 'The app will close and the installer will start automatically.'}
              {stage === 'error' && 'The download failed. Use the button below to retry.'}
            </div>
            <div className="flex items-center gap-2 justify-end">
              {stage === 'idle' && (
                <button onClick={approve} className="border border-cyan-400/50 px-4 py-2 rounded-lg text-sm text-cyan-50 hover:bg-cyan-400/10 shrink-0">
                  Update
                </button>
              )}
              {stage === 'ready' && (
                <button onClick={install} className="border border-cyan-400/50 px-4 py-2 rounded-lg text-sm text-cyan-50 hover:bg-cyan-400/10 shrink-0">
                  Install and Restart
                </button>
              )}
              {stage === 'error' && (
                <button onClick={approve} className="border border-cyan-400/50 px-4 py-2 rounded-lg text-sm text-cyan-50 hover:bg-cyan-400/10 shrink-0">
                  Try Again
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed top-0 inset-x-0 z-[97] bg-cyan-950/95 border-b border-cyan-400/40 text-cyan-100 px-4 py-2 flex items-center justify-center gap-3 text-xs tracking-wide">
      <Download className="w-4 h-4 shrink-0" />
      {stage === 'idle' && (
        <>
          <span>A new version is available: v{info.version}</span>
          <button onClick={approve} className="border border-cyan-400/50 px-3 py-1 rounded hover:bg-cyan-400/10 shrink-0">
            Update
          </button>
        </>
      )}
      {stage === 'downloading' && <span>Downloading{pct !== null ? ` (${pct}%)` : '...'}</span>}
      {stage === 'ready' && (
        <>
          <span>v{info.version} downloaded.</span>
          <button onClick={install} className="border border-cyan-400/50 px-3 py-1 rounded hover:bg-cyan-400/10 shrink-0">
            Install and Restart
          </button>
        </>
      )}
      {stage === 'error' && (
        <>
          <span>Download failed.</span>
          <button onClick={approve} className="border border-cyan-400/50 px-3 py-1 rounded hover:bg-cyan-400/10 shrink-0">
            Try Again
          </button>
        </>
      )}
        <button onClick={() => { setDismissedVersion(info.version); setStage('dismissed'); }} className="ml-2 shrink-0" aria-label="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
  );
}
