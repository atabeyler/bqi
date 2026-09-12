import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw, WifiOff } from 'lucide-react';
import { isNativeApp, nativeConnectivity, nativeSync } from '../services/nativeBridge.js';
import { isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';

const LABELS = {
  cloud: { text: 'Q CLOUD', icon: Cloud, className: 'text-emerald-400 border-emerald-400/40' },
  sync: { text: 'SYNC', icon: RefreshCw, className: 'text-cyan-300 border-cyan-300/40 animate-pulse' },
  local: { text: 'Q LOCAL', icon: CloudOff, className: 'text-gold/70 border-gold/40' },
  // Shown instead of 'local' when the user has manually switched Offline
  // Mode on (Settings > Bağlantı) AND the underlying connectivity state also
  // happens to be 'local' -- a distinct accent color (amber/gold-red vs the
  // plain 'local' state's gold) makes clear this is a deliberate choice, not
  // just the automatic detector reporting no reachability. desktop/
  // connectivity.js and the mobile connectivity poller are untouched; this
  // is purely a render-time relabeling here.
  localManual: { text: 'Q LOCAL · MANUEL', icon: WifiOff, className: 'text-amber-400 border-amber-400/50' },
};

// Native-app-only status chip (spec point 6: the user never picks cloud vs.
// local manually — this just reflects which mode the app is currently in).
// Covers both Electron and Capacitor/Android (see services/nativeBridge.js);
// renders nothing at all on the web build, since isNativeApp is false there.
export default function DesktopSyncBadge() {
  const [state, setState] = useState('local');
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());

  useEffect(() => {
    if (!isNativeApp) return undefined;
    nativeSync.status().then((s) => s && setState(s.state)).catch(() => {});
    return nativeConnectivity.onChange(setState);
  }, []);

  useEffect(() => subscribeAppModePreference((mode) => setAppModeOffline(mode === 'offline')), []);

  if (!isNativeApp) return null;

  // Manual Offline Mode always wins, regardless of the underlying
  // connectivity state -- main/mobileBridge stop polling entirely once it's
  // on (see desktop/appMode.js), so `state` is just stale leftover data from
  // before the switch, not a live signal worth branching on here.
  const effectiveState = appModeOffline ? 'localManual' : state;
  // Every badge label here (Q CLOUD/SYNC/Q LOCAL, and now Q LOCAL · MANUEL)
  // is a hardcoded status-code string, not run through t() -- matches the
  // existing precedent for this component rather than adding a translated
  // variant just for the new state.
  const { text, icon: Icon, className } = LABELS[effectiveState] || LABELS.local;
  return (
    <span
      className={`btn-depth header-control h-[28px] sm:h-[30px] px-2.5 py-0 rounded text-xs tracking-widest font-display flex items-center gap-1.5 shrink-0 border ${className}`}
      title="BQI çalışma modu"
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">{text}</span>
    </span>
  );
}
