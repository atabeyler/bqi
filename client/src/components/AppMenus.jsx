import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, Moon, Sun, Monitor, Search as SearchIcon, KeyRound, Trash2, Pencil, Fingerprint, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import QuantumLogo from './QuantumLogo.jsx';
import LocalAIPanel from './LocalAIPanel.jsx';
import { isPushSupported, getPushSubscriptionState, subscribeToPush, unsubscribeFromPush } from '../services/push.js';
import { isPasskeySupported, registerPasskey } from '../services/webauthn.js';
import { isNativeApp } from '../services/nativeBridge.js';
import { api } from '../services/api.js';
import { guideModules } from '../services/i18n.js';
import { formatLocalDateTime } from '../services/dateTime.js';
import { isRtl } from '../services/langContext.jsx';
import { getAppMode, setAppMode, isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';
import '../theme.css';

const THEME_KEY = 'bqi-theme';
const VALID_THEMES = new Set(['dark', 'light', 'system']);

function resolveTheme(mode) {
  if (mode === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode === 'light' ? 'light' : 'dark';
}

function applyTheme(mode) {
  if (typeof document === 'undefined') return;
  const safeMode = VALID_THEMES.has(mode) ? mode : 'dark';
  document.documentElement.dataset.themeMode = safeMode;
  document.documentElement.dataset.theme = resolveTheme(safeMode);
  document.documentElement.style.colorScheme = resolveTheme(safeMode);
}

function getStoredTheme() {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(THEME_KEY);
  return VALID_THEMES.has(saved) ? saved : 'dark';
}

// Persists + applies a theme mode outside of SettingsPanel's own React
// state -- used by the voice assistant's set_theme action (see
// dashboardVoiceActions.js) so "koyu temaya geç" works whether or not the
// settings panel happens to be open, the same way the panel's own theme
// buttons do (setTheme() there does exactly this, just from local state).
function setThemePersisted(mode) {
  const safeMode = VALID_THEMES.has(mode) ? mode : 'dark';
  try { window.localStorage.setItem(THEME_KEY, safeMode); } catch {}
  applyTheme(safeMode);
}

if (typeof window !== 'undefined') {
  applyTheme(getStoredTheme());
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  media?.addEventListener?.('change', () => {
    if (getStoredTheme() === 'system') applyTheme('system');
  });
}

function DropdownOverlay({ onClose, closeLabel }) {
  return <motion.button type="button" aria-label={closeLabel} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[69] bg-transparent cursor-default" />;
}

function MenuPanel({ t, onClose, onOpenGuide, onOpenInfo }) {
  const items = [
    { key: 'usageGuideTitle', onClick: onOpenGuide },
    { key: 'menuAboutUs', onClick: () => onOpenInfo('about') },
    { key: 'menuMissionVision', onClick: () => onOpenInfo('mission') },
    { key: 'menuContact', onClick: () => onOpenInfo('contact') },
  ];
  return <><DropdownOverlay onClose={onClose} closeLabel={t('menuTooltip')} /><motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="fixed top-16 right-3 sm:right-6 z-[70] w-[92vw] sm:w-[340px] border border-cyan-300/30 rounded-lg bg-[#061326]/95 backdrop-blur p-3 shadow-xl theme-surface" onClick={(e) => e.stopPropagation()}>
    <div className="flex items-center justify-between mb-3 pb-3 border-b border-gold/20"><div className="flex items-center gap-2"><QuantumLogo size="sm" /><div><div className="font-display text-gold text-sm tracking-[0.2em]">{t('appName')}</div><div className="text-xs text-gold/50 tracking-widest uppercase">{t('appSubtitle')}</div></div></div><button onClick={onClose} className="text-cyan-200/70 hover:text-cyan-100" title={t('menuTooltip')} aria-label="Close"><X className="w-4 h-4" /></button></div>
    <div className="space-y-1">{items.map((item) => <button key={item.key} onClick={item.onClick} className="w-full text-left rounded px-2.5 py-2 text-sm text-cyan-100 hover:bg-white/5 hover:text-cyan-50 transition">{t(item.key)}</button>)}</div>
    <div className="mt-3 pt-3 border-t border-gold/20"><p className="text-xs text-gold/40 tracking-widest">{t('projectCode')}: QTR-200120401018</p><p className="text-xs text-gold/40 mt-1 leading-relaxed"><span className="text-gold/60">{t('company')}</span>{' · '}{t('rights')}{' · '}{t('classified')}</p></div>
  </motion.div></>;
}

const SETTINGS_LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'tr', label: 'Türkçe' }, { code: 'de', label: 'Deutsch' }, { code: 'fr', label: 'Français' }, { code: 'ar', label: 'العربية' },
];

const THEME_COPY = {
  tr: { title: 'Tema', dark: 'Koyu', light: 'Açık', system: 'Sistem', hint: 'Sistem seçeneği cihazınızın görünüm ayarını otomatik takip eder.' },
  en: { title: 'Theme', dark: 'Dark', light: 'Light', system: 'System', hint: 'System follows your device appearance automatically.' },
  de: { title: 'Design', dark: 'Dunkel', light: 'Hell', system: 'System', hint: 'System folgt automatisch der Darstellung Ihres Geräts.' },
  fr: { title: 'Thème', dark: 'Sombre', light: 'Clair', system: 'Système', hint: 'Système suit automatiquement le mode de votre appareil.' },
  ar: { title: 'السمة', dark: 'داكن', light: 'فاتح', system: 'النظام', hint: 'يتبع خيار النظام إعداد مظهر جهازك تلقائياً.' },
};

// BQI's shared destructive-action confirmation, styled to match
// InfoModal/GuideModal's hud-panel treatment elsewhere in this file --
// used here so removing a passkey (which can lock a user out of their
// fastest login method) is never a single misclick.
function ConfirmModal({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel, busy }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 theme-overlay"
      onClick={onCancel}>
      <motion.div initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-sm hud-panel rounded-t-2xl sm:rounded-xl p-4 sm:p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-8 h-8 rounded-full bg-red-500/15 border border-red-400/30 flex items-center justify-center shrink-0">
            <TriangleAlert className="w-4 h-4 text-red-300" />
          </div>
          <div className="min-w-0">
            <h3 className="text-cyan-100 font-display tracking-wide text-sm">{title}</h3>
            <p className="text-xs text-cyan-100/70 leading-relaxed mt-1">{body}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded text-xs text-cyan-100/80 border border-cyan-300/25 hover:bg-white/5 disabled:opacity-40">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} disabled={busy} className="px-3 py-1.5 rounded text-xs text-red-100 bg-red-500/20 border border-red-400/40 hover:bg-red-500/30 disabled:opacity-40">
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function formatDateTime(iso, lang) {
  if (!iso) return null;
  return formatLocalDateTime(iso, lang, { timeStyle: 'short' });
}

// ─── Security tab: passkey/device management ──────────────────────────────
// Only ever rendered when SettingsPanel is opened from an authenticated
// screen (DashboardPage.jsx passes authenticated) -- registering, renaming
// or removing a passkey all require the caller's own session, enforced
// server-side regardless (see server/src/routes/webauthn.js's
// authMiddleware), this just keeps the tab from appearing pre-login.
function SecurityPanel({ t, lang, onForgetDevice }) {
  const [credentials, setCredentials] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [removeTarget, setRemoveTarget] = useState(null); // credential pending delete confirmation
  const [removing, setRemoving] = useState(false);
  const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);
  // Passkey registration/management requires server calls, so it's disabled
  // (with an explanatory hint) while the app-wide Offline Mode toggle
  // (Settings > Bağlantı) is on -- "Bu Cihazı Unut" just above stays enabled
  // either way since it's a purely local operation.
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());
  // Re-fetch the passkey list once connectivity comes back (Offline -> Auto)
  // so it doesn't stay empty/stale for the rest of the session.
  useEffect(() => subscribeAppModePreference((mode) => {
    const offline = mode === 'offline';
    setAppModeOffline(offline);
    if (!offline) load();
  }), []);
  const passkeySupported = isPasskeySupported();
  const passkeyDisabled = !passkeySupported || appModeOffline;

  const load = () => {
    // Listing passkeys is a server round-trip -- skip it while Offline Mode
    // is on (mirrors the register/rename/remove gating below) instead of
    // leaving the list stuck on "loading" or hitting a call guaranteed to
    // fail against a suspended connection. securityPasskeyOfflineModeHint
    // already explains the empty list, so no separate offline flag needed.
    if (isAppModeOffline()) { setCredentials([]); return; }
    api.webauthn.listCredentials().then(setCredentials).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const handleRegister = async () => {
    setError('');
    setBusy(true);
    try {
      // An empty name is sent as undefined -- the server then falls back to
      // its own generic, non-identifying default ("Passkey", see
      // toCredentialJson in routes/webauthn.js) rather than this client
      // guessing at a label from the UA string.
      const name = newDeviceName.trim();
      await registerPasskey(name || undefined);
      setNewDeviceName('');
      load();
    } catch (e) {
      setError(e?.message || t('securityPasskeyAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setError('');
    setRemoving(true);
    try {
      await api.webauthn.removeCredential(removeTarget.id);
      setCredentials((prev) => (prev || []).filter((c) => c.id !== removeTarget.id));
      setRemoveTarget(null);
    } catch (e) {
      setError(e?.message || t('securityPasskeyRemoveFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const startRename = (cred) => { setRenamingId(cred.id); setRenameValue(cred.deviceName); };

  const saveRename = async (id) => {
    const name = renameValue.trim();
    if (!name) { setRenamingId(null); return; }
    setError('');
    try {
      const { credential } = await api.webauthn.renameCredential(id, name);
      setCredentials((prev) => (prev || []).map((c) => (c.id === id ? credential : c)));
    } catch (e) {
      setError(e?.message || t('securityPasskeyRenameFailed'));
    } finally {
      setRenamingId(null);
    }
  };

  return (
    <div>
      <p className="text-xs text-gold/60 leading-relaxed mb-3">{t('securityPasskeyIntro')}</p>

      {!passkeySupported && (
        <p className="text-[14px] text-gold/50 mb-3">{t('securityPasskeyUnsupported')}</p>
      )}

      {passkeySupported && appModeOffline && (
        <p className="text-[14px] text-gold/50 mb-3">{t('securityPasskeyOfflineModeHint')}</p>
      )}

      {error && <p className="text-[14px] text-red-300 mb-2">{error}</p>}

      {credentials === null && <p className="text-xs text-cyan-100/50">{t('securityPasskeyLoading')}</p>}

      {credentials && credentials.length === 0 && (
        <p className="text-xs text-cyan-100/50 mb-3">{t('securityPasskeyEmpty')}</p>
      )}

      {credentials && credentials.length > 0 && (
        <div className="space-y-2 mb-3">
          {credentials.map((cred) => (
            <div key={cred.id} className="flex items-center justify-between gap-2 border border-cyan-300/20 rounded px-2.5 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Fingerprint className="w-4 h-4 text-cyan-300/60 shrink-0" />
                <div className="min-w-0">
                  {renamingId === cred.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => saveRename(cred.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(cred.id); if (e.key === 'Escape') setRenamingId(null); }}
                      className="bg-[#020c18] border border-cyan-500/30 rounded px-1.5 py-0.5 text-xs text-cyan-100 w-full"
                    />
                  ) : (
                    <div className="text-xs text-cyan-100 truncate">{cred.deviceName}</div>
                  )}
                  <div className="text-[13px] text-cyan-300/40 leading-relaxed">
                    <div>{t('securityPasskeyCreated')}: {formatDateTime(cred.createdAt, lang) || '—'}</div>
                    <div>{cred.lastUsedAt ? `${t('securityPasskeyLastUsed')}: ${formatDateTime(cred.lastUsedAt, lang)}` : t('securityPasskeyNeverUsed')}</div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => startRename(cred)} disabled={appModeOffline} className="text-cyan-300/60 hover:text-cyan-100 p-1 disabled:opacity-40 disabled:hover:text-cyan-300/60" aria-label={t('securityPasskeyRename')} title={t('securityPasskeyRename')}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setRemoveTarget(cred)} disabled={appModeOffline} className="text-red-300/70 hover:text-red-300 p-1 disabled:opacity-40 disabled:hover:text-red-300/70" aria-label={t('securityPasskeyRemove')} title={t('securityPasskeyRemove')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <input
          type="text"
          value={newDeviceName}
          onChange={(e) => setNewDeviceName(e.target.value)}
          placeholder={t('securityPasskeyNamePh')}
          disabled={busy || passkeyDisabled}
          maxLength={200}
          className="w-full bg-[#020c18] border border-cyan-500/25 rounded px-2.5 py-2 text-xs text-cyan-100 placeholder-cyan-300/30 focus:border-cyan-400/60 focus:outline-none disabled:opacity-40"
        />
        <button
          onClick={handleRegister}
          disabled={busy || passkeyDisabled}
          className="w-full flex items-center justify-center gap-2 text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2 disabled:opacity-40"
        >
          <KeyRound className="w-4 h-4" />
          {busy ? t('securityPasskeyAdding') : t('securityPasskeyAdd')}
        </button>
      </div>

      <AnimatePresence>
        {removeTarget && (
          <ConfirmModal
            title={t('securityPasskeyRemoveConfirmTitle')}
            body={t('securityPasskeyRemoveConfirmBody').replace('{name}', removeTarget.deviceName)}
            confirmLabel={removing ? t('securityPasskeyAdding') : t('securityPasskeyRemove')}
            cancelLabel={t('cancel')}
            busy={removing}
            onConfirm={confirmRemove}
            onCancel={() => setRemoveTarget(null)}
          />
        )}
      </AnimatePresence>

      {isNativeApp && (
        <div className="mt-4 pt-4 border-t border-gold/20">
          <div className="text-xs tracking-[0.18em] uppercase text-gold/60 mb-1">{t('securityDeviceForgetTitle')}</div>
          <p className="text-[13px] text-gold/45 leading-relaxed mb-2">{t('securityDeviceForgetHint')}</p>
          <button
            onClick={() => setForgetConfirmOpen(true)}
            className="w-full flex items-center justify-center gap-2 text-[14px] border border-red-400/30 text-red-200 rounded px-2.5 py-2 hover:bg-red-500/10"
          >
            {t('securityDeviceForgetTitle')}
          </button>
        </div>
      )}

      <AnimatePresence>
        {forgetConfirmOpen && (
          <ConfirmModal
            title={t('securityDeviceForgetConfirmTitle')}
            body={t('securityDeviceForgetConfirmBody')}
            confirmLabel={t('securityDeviceForgetConfirmBtn')}
            cancelLabel={t('securityDeviceForgetCancelBtn')}
            onConfirm={() => { setForgetConfirmOpen(false); onForgetDevice?.(); }}
            onCancel={() => setForgetConfirmOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Connection tab: app-wide Offline Mode toggle ──────────────────────────
// Otomatik (default) leaves cloud connectivity/sync/online services to the
// app's own automatic connectivity detection (see nativeConnectivity /
// DesktopSyncBadge). Çevrimdışı is a user-selected override that suspends
// all of that regardless of actual reachability -- see appModePreference.js
// and the various gating call sites (socket, weather, update check, cloud AI
// routing, passkey UI) it feeds. Switching to Çevrimdışı requires confirming
// a ConfirmModal (same shared component as the passkey-remove/forget-device
// flows above); switching back to Otomatik is immediate and triggers
// reconciliation (DashboardPage.jsx's aq:app-mode-reconnect listener).
function ConnectionPanel({ t }) {
  const [mode, setMode] = useState(() => getAppMode());
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => subscribeAppModePreference(setMode), []);

  const switchToAuto = () => {
    setAppMode('auto');
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('aq:app-mode-reconnect'));
  };

  const confirmOffline = () => {
    setConfirmOpen(false);
    setAppMode('offline');
  };

  return (
    <div>
      <div className="text-xs tracking-[0.18em] uppercase text-gold/60 mb-2">{t('appModeTitle')}</div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          type="button"
          onClick={switchToAuto}
          className={`rounded-lg border px-2 py-3 flex flex-col items-center gap-1.5 transition ${mode === 'auto' ? 'border-cyan-300/70 bg-cyan-500/15 text-cyan-100' : 'border-cyan-300/25 text-cyan-100/65 hover:bg-white/5'}`}
        >
          <Wifi className="w-4 h-4" />
          <span className="text-[14px]">{t('appModeAuto')}</span>
          {mode === 'auto' && <Check className="w-3.5 h-3.5 text-cyan-300" />}
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className={`rounded-lg border px-2 py-3 flex flex-col items-center gap-1.5 transition ${mode === 'offline' ? 'border-gold/70 bg-gold/15 text-gold' : 'border-cyan-300/25 text-cyan-100/65 hover:bg-white/5'}`}
        >
          <WifiOff className="w-4 h-4" />
          <span className="text-[14px]">{t('appModeOffline')}</span>
          {mode === 'offline' && <Check className="w-3.5 h-3.5 text-gold" />}
        </button>
      </div>

      {mode === 'offline' && (
        <div className="text-[13px] tracking-widest uppercase text-gold/80 border border-gold/30 rounded px-2.5 py-2 text-center">
          {t('appModeManualBadge')}
        </div>
      )}

      <AnimatePresence>
        {confirmOpen && (
          <ConfirmModal
            title={t('appModeOfflineConfirmTitle')}
            body={t('appModeOfflineConfirmBody')}
            confirmLabel={t('appModeOfflineConfirmBtn')}
            cancelLabel={t('appModeOfflineCancelBtn')}
            onConfirm={confirmOffline}
            onCancel={() => setConfirmOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SettingsPanel({ t, lang, setLang, onClose, soundEnabled, setSoundEnabled, soundVolume, setSoundVolume, sidebarCollapsed, setSidebarCollapsed, onOpenGuide, onForgetDevice, showAppearance = true, authenticated = false }) {
  const [tab, setTab] = useState('language');
  const [pushState, setPushState] = useState('checking');
  const [pushError, setPushError] = useState('');
  const [themeMode, setThemeMode] = useState(getStoredTheme);
  const themeCopy = THEME_COPY[lang] || THEME_COPY.en;

  useEffect(() => {
    if (!isPushSupported()) { setPushState('unsupported'); return; }
    getPushSubscriptionState().then(setPushState).catch(() => setPushState('unsupported'));
  }, []);

  const setTheme = (mode) => {
    setThemeMode(mode);
    setThemePersisted(mode);
  };

  const togglePush = async () => {
    setPushError('');
    try {
      if (pushState === 'subscribed') {
        await unsubscribeFromPush();
        setPushState('unsubscribed');
      } else {
        setPushState('checking');
        await subscribeToPush();
        setPushState('subscribed');
      }
    } catch (e) {
      // push.js throws machine-readable codes ('push_unsupported', ...), not
      // human text -- t() falls back to the raw key if a code has no match,
      // so an unrecognized future code still shows something rather than
      // crashing. err${PascalCase(code)} mirrors LoginPage.jsx's identical
      // localizedAuthError() mapping for the auth-error codes.
      const key = `err${String(e.message || '').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
      setPushError(t(key) || e.message);
      setPushState(await getPushSubscriptionState().catch(() => 'unsubscribed'));
    }
  };

  const tabs = [
    { key: 'language', label: t('settingsLanguage') }, { key: 'sound', label: t('settingsSound') }, { key: 'push', label: t('settingsPush') }, ...(showAppearance ? [{ key: 'appearance', label: t('settingsAppearance') }] : []), ...(authenticated ? [{ key: 'security', label: t('settingsSecurity') }] : []), { key: 'connection', label: t('settingsConnection') }, { key: 'localAI', label: t('settingsLocalAI') }, { key: 'about', label: t('settingsAbout') },
  ];

  const themeOptions = [
    { key: 'dark', label: themeCopy.dark, Icon: Moon },
    { key: 'light', label: themeCopy.light, Icon: Sun },
    { key: 'system', label: themeCopy.system, Icon: Monitor },
  ];

  return <><DropdownOverlay onClose={onClose} closeLabel={t('settingsTooltip')} /><motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="fixed top-16 right-3 sm:right-6 z-[70] w-[92vw] sm:w-[380px] max-h-[75vh] overflow-hidden flex flex-col border border-cyan-300/30 rounded-lg bg-[#061326]/95 backdrop-blur shadow-xl theme-surface" onClick={(e) => e.stopPropagation()}>
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-gold/20 shrink-0"><div className="flex items-center gap-2"><span className="w-1 h-4 bg-cyan-400 rounded-full" /><div className="text-[14px] tracking-widest uppercase text-cyan-200">{t('settingsTitle')}</div></div><button onClick={onClose} className="text-cyan-200/70 hover:text-cyan-100" aria-label="Close"><X className="w-4 h-4" /></button></div>
    <div className="flex border-b border-gold/10 px-1 shrink-0 overflow-x-auto">{tabs.map((tb) => <button key={tb.key} onClick={() => setTab(tb.key)} className={`relative px-3 py-2 text-[14px] tracking-wide uppercase transition whitespace-nowrap ${tab === tb.key ? 'text-cyan-200' : 'text-cyan-100/40 hover:text-cyan-100/70'}`}>{tb.label}{tab === tb.key && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-cyan-400 rounded-full" />}</button>)}</div>
    <div className="p-3 overflow-auto flex-1">
      {tab === 'language' && <div className="space-y-0.5">{SETTINGS_LANGUAGES.map((l) => <button key={l.code} onClick={() => setLang(l.code)} dir={isRtl(l.code) ? 'rtl' : 'ltr'} className={`w-full flex items-center justify-between px-2.5 py-2.5 rounded text-sm transition ${lang === l.code ? 'bg-cyan-500/10 text-cyan-100' : 'text-cyan-100/70 hover:bg-white/5'}`}><span>{l.label}</span>{lang === l.code && <Check className="w-4 h-4 text-cyan-300 shrink-0" />}</button>)}</div>}
      {tab === 'sound' && <div><button onClick={() => setSoundEnabled((v) => !v)} className="w-full flex items-center justify-between text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2 mb-3"><span>{t('settingsSoundEnable')}</span>{soundEnabled ? <Check className="w-4 h-4 text-cyan-300" /> : <X className="w-4 h-4 text-cyan-100/40" />}</button><div className="flex items-center gap-2"><span className="text-xs text-gold/50 shrink-0">{t('settingsSoundVolume')}</span><input type="range" min="0.02" max="0.2" step="0.01" value={soundVolume} onChange={(e) => setSoundVolume(Number(e.target.value))} className="flex-1" /></div></div>}
      {tab === 'push' && <div><button onClick={togglePush} disabled={pushState === 'unsupported' || pushState === 'checking'} className="w-full flex items-center justify-between text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2 mb-2 disabled:opacity-40"><span>{t('settingsPushEnable')}</span>{pushState === 'subscribed' ? <Check className="w-4 h-4 text-cyan-300" /> : <X className="w-4 h-4 text-cyan-100/40" />}</button>{pushState === 'unsupported' && <p className="text-[14px] text-gold/50">{t('settingsPushUnsupported')}</p>}{pushError && <p className="text-[14px] text-red-300">{pushError}</p>}</div>}
      {tab === 'appearance' && <div className="space-y-4">
        <div>
          <div className="text-xs tracking-[0.18em] uppercase text-gold/60 mb-2">{themeCopy.title}</div>
          <div className="grid grid-cols-3 gap-2">{themeOptions.map(({ key, label, Icon }) => <button type="button" key={key} onClick={() => setTheme(key)} className={`theme-option rounded-lg border px-2 py-3 flex flex-col items-center gap-1.5 transition ${themeMode === key ? 'theme-option-active border-cyan-300/70 bg-cyan-500/15 text-cyan-100' : 'border-cyan-300/25 text-cyan-100/65 hover:bg-white/5'}`}><Icon className="w-4 h-4" /><span className="text-[14px]">{label}</span>{themeMode === key && <Check className="w-3.5 h-3.5 text-cyan-300" />}</button>)}</div>
          <p className="text-xs text-gold/45 mt-2 leading-relaxed">{themeCopy.hint}</p>
        </div>
        {typeof setSidebarCollapsed === 'function' && <button onClick={() => setSidebarCollapsed((v) => !v)} className="w-full flex items-center justify-between text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2"><span>{t('settingsCollapseSidebar')}</span>{sidebarCollapsed ? <Check className="w-4 h-4 text-cyan-300" /> : <X className="w-4 h-4 text-cyan-100/40" />}</button>}
      </div>}
      {tab === 'security' && authenticated && <SecurityPanel t={t} lang={lang} onForgetDevice={onForgetDevice} />}
      {tab === 'connection' && <ConnectionPanel t={t} />}
      {tab === 'localAI' && <LocalAIPanel t={t} />}
      {tab === 'about' && <div><p className="text-[14px] text-cyan-100/80 mb-3">{t('appName')} · {t('settingsVersion')} {__APP_VERSION__}</p><button onClick={onOpenGuide} className="text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2">{t('settingsOpenGuide')}</button></div>}
    </div>
  </motion.div></>;
}

function InfoModal({ panel, t, onClose }) {
  const content = {
    about: { title: t('aboutUsTitle'), body: <p className="text-sm text-cyan-100/85 leading-relaxed">{t('aboutUsBody')}</p> },
    mission: { title: t('missionVisionTitle'), body: <div className="space-y-3"><div><div className="text-xs text-gold/60 tracking-widest uppercase mb-1">{t('missionLabel')}</div><p className="text-sm text-cyan-100/85 leading-relaxed">{t('missionBody')}</p></div><div><div className="text-xs text-gold/60 tracking-widest uppercase mb-1">{t('visionLabel')}</div><p className="text-sm text-cyan-100/85 leading-relaxed">{t('visionBody')}</p></div></div> },
    contact: { title: t('contactTitle'), body: <div className="space-y-2"><p className="text-sm text-cyan-100/85 leading-relaxed">{t('contactBody')}</p><p className="text-xs text-gold/70">{t('contactEmailLabel')}: info@boldas.com.tr</p></div> },
  }[panel];
  if (!content) return null;
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[71] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 theme-overlay" onClick={onClose}><motion.div initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }} onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-lg overflow-auto hud-panel rounded-t-2xl sm:rounded-xl p-4 sm:p-6"><div className="flex items-center justify-between mb-4"><h3 className="text-cyan-100 font-display tracking-widest text-sm sm:text-lg">{content.title}</h3><button onClick={onClose} className="text-cyan-100/70 hover:text-cyan-100" aria-label="Close"><X className="w-5 h-5" /></button></div>{content.body}</motion.div></motion.div>;
}

function highlightMatch(text, query) {
  if (!query) return text;
  const idx = text.toLocaleLowerCase('tr').indexOf(query);
  if (idx === -1) return text;
  return <>{text.slice(0, idx)}<mark className="bg-gold/40 text-cyan-50 rounded-sm">{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}</>;
}

function GuideModal({ onClose, t, lang }) {
  const modules = guideModules[lang] || guideModules.en || guideModules.tr;
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase('tr');
  const filtered = normalizedQuery
    ? modules
        .map(([title, body]) => [title, body, body.split('|')])
        .filter(([title, , items]) => title.toLocaleLowerCase('tr').includes(normalizedQuery) || items.some((item) => item.toLocaleLowerCase('tr').includes(normalizedQuery)))
    : modules.map(([title, body]) => [title, body, body.split('|')]);

  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[65] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 theme-overlay" onClick={onClose}><motion.div initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }} onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-2xl h-[88vh] sm:h-auto sm:max-h-[85vh] overflow-auto hud-panel rounded-t-2xl sm:rounded-xl p-4 sm:p-6"><div className="flex items-center justify-between mb-4"><h3 className="text-cyan-100 font-display tracking-widest text-sm sm:text-lg">{t('usageGuideTitle')}</h3><button onClick={onClose} className="text-cyan-100/70 hover:text-cyan-100" aria-label="Close"><X className="w-5 h-5" /></button></div><p className="text-xs sm:text-sm text-gold/70 mb-3">{t('usageGuideIntro')}</p>
    <div className="relative mb-4">
      <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-300/40" />
      <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('usageGuideSearchPh')} className="w-full pl-8 pr-8 py-2 bg-[#020c18] border border-cyan-500/25 rounded-sm text-sm text-cyan-100 placeholder-cyan-300/30 focus:border-cyan-400/60 focus:outline-none" />
      {query && <button onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cyan-300/50 hover:text-cyan-100" aria-label="Clear search"><X className="w-3.5 h-3.5" /></button>}
    </div>
    <div className="space-y-4">
      {filtered.length === 0 && <p className="text-xs sm:text-sm text-gold/50 text-center py-6">{t('usageGuideNoResults')}</p>}
      {filtered.map(([title, , items], i) => <div key={i} className="border border-cyan-300/25 rounded-lg p-3 sm:p-4 bg-[#071225]/70 theme-card"><h4 className="text-cyan-100 text-xs sm:text-sm tracking-widest mb-2">{highlightMatch(title, normalizedQuery)}</h4><div className="space-y-1.5 text-xs sm:text-sm text-gold/90 leading-relaxed">{items.map((item, j) => <p key={j}>- {highlightMatch(item, normalizedQuery)}</p>)}</div></div>)}
    </div>
  </motion.div></motion.div>;
}

export { DropdownOverlay, MenuPanel, SettingsPanel, InfoModal, GuideModal, applyTheme, getStoredTheme, setThemePersisted };
