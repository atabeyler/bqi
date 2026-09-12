import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { isNativeApp, nativeAuth } from '../services/nativeBridge.js';
import { t } from '../services/i18n.js';

// Native-app-only: a cached JWT from a previous online login can expire
// while the device was offline for a long stretch (see
// desktop/auth/session.js's needsReauth). Reconnecting with an expired
// token means every sync call fails with 401 -- there is no server-side
// refresh-token endpoint to silently renew it with, so the only safe path
// is prompting the user to log in again. This banner just triggers the
// app's normal logout -> LoginPage flow (onLogout, same as the header's
// logout button) rather than building a second login form: local SQLite
// data and the sync queue are completely untouched by that, and the very
// next login (whichever account/device authorization flow already
// exists) refreshes the cached session and lets any queued offline
// changes sync automatically. Renders nothing on the web build or when
// no reauth is currently needed.
export default function ReauthBanner({ onLogout, lang = 'tr' }) {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!isNativeApp) return undefined;
    nativeAuth.needsReauth().then(setNeeded).catch(() => {});
    return nativeAuth.onReauthRequired(() => setNeeded(true));
  }, []);

  if (!isNativeApp || !needed) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[96] bg-amber-950/95 border-b border-amber-400/40 text-amber-100 px-4 py-2 flex items-center justify-center gap-3 text-xs tracking-wide">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>{t(lang, 'reauthBannerText')}</span>
      <button
        onClick={onLogout}
        className="border border-amber-400/50 px-3 py-1 rounded text-amber-100 hover:bg-amber-400/10 shrink-0"
      >
        {t(lang, 'reauthLoginAgainBtn')}
      </button>
    </div>
  );
}
