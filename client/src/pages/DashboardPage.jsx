import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { History, LogOut, Mic, X, Bell, CalendarDays, Clock3, Thermometer, Menu as MenuIcon, Settings as SettingsIcon, Users } from 'lucide-react';
import EmergencyButton from '../components/EmergencyButton.jsx';
import CategorySidebar from '../components/CategorySidebar.jsx';
import HomeView from '../components/HomeView.jsx';
import AnalysisView from '../components/AnalysisView.jsx';
import HistoryView from '../components/HistoryView.jsx';
import VoiceChat from '../components/VoiceChat.jsx';
import { localeFor } from '../services/i18n.js';
import { repairLegacyText } from '../services/textRepair.js';
import { RadarModal } from '../components/PersonnelRadar.jsx';
import UserManagementModal from '../components/UserManagement.jsx';
import { MenuPanel, SettingsPanel, InfoModal, GuideModal } from '../components/AppMenus.jsx';
import AppFooter from '../components/AppFooter.jsx';
import DesktopSyncBadge from '../components/DesktopSyncBadge.jsx';
import DesktopConflictModal from '../components/DesktopConflictModal.jsx';
import ReauthBanner from '../components/ReauthBanner.jsx';
import { api, setJWT, setLocalAuthUser, getToken, logoutRequest, clearLocalChatHistory } from '../services/api.js';
import { fullLogout } from '../services/fullLogout.js';
import { registerActions, unregisterActions } from '../services/voiceActionRegistry.js';
import { buildDashboardVoiceActions } from '../services/dashboardVoiceActions.js';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket.js';
import { useLang } from '../services/langContext.jsx';
import { isMobileApp, mobileGeolocation } from '../services/mobileBridge.js';
import { isNativeApp, nativeAuth, nativeSync } from '../services/nativeBridge.js';
import { isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';

const DAYS_SHORT = {
  tr: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
  ar: ['أحد', 'إثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'],
};

export default function DashboardPage({ user, onLogout }) {
  const navigate = useNavigate();
  const { t, lang, setLang } = useLang();
  const [view, setView] = useState('home');
  const [activeCategory, setActiveCategory] = useState(null);
  // Fields a voice command (start_analysis) resolved for the analysis
  // wizard beyond the category itself -- depth/quantum/prompt/title.
  // AnalysisView applies and clears them on mount/update rather than this
  // owning any wizard-internal state directly.
  const [pendingAnalysis, setPendingAnalysis] = useState(null);
  const [emergencyToast, setEmergencyToast] = useState(null);
  const [voiceChatOpen, setVoiceChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoPanel, setInfoPanel] = useState(null); // 'about' | 'mission' | 'contact' | null
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  );
  const [radarOpen, setRadarOpen] = useState(false);
  const [userMgmtOpen, setUserMgmtOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notifFilter, setNotifFilter] = useState('all');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundVolume, setSoundVolume] = useState(0.09);
  const [now, setNow] = useState(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [myCoords, setMyCoords] = useState(null);
  const [liveTemp, setLiveTemp] = useState(null);
  const [tempLoading, setTempLoading] = useState(false);
  const calendarRef = useRef(null);
  const unreadCount = notifications.filter((n) => !n.read).length;
  const normalizeText = repairLegacyText;
  const notifyDevice = (title, body) => {
    try {
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return;
      const n = new Notification(title, { body, tag: 'bqi-alert' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {}
  };
  const daysShort = DAYS_SHORT[lang] || DAYS_SHORT.tr;

  const monthLabel = new Intl.DateTimeFormat(localeFor(lang), {
    month: 'long',
    year: 'numeric'
  }).format(viewMonth);
  const liveTime = new Intl.DateTimeFormat(localeFor(lang), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(now);
  const liveDate = new Intl.DateTimeFormat(localeFor(lang), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(now);

  const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const calendarCells = Array.from({ length: firstDay }, () => null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );

  const formatYmd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const year = viewMonth.getFullYear();
  const fixedEvents = {
    [`${year}-01-01`]: ['Yılbaşı'],
    [`${year}-04-23`]: ['23 Nisan Ulusal Egemenlik ve Çocuk Bayramı'],
    [`${year}-05-01`]: ['Emek ve Dayanışma Günü'],
    [`${year}-05-19`]: ['19 Mayıs Atatürk\'ü Anma, Gençlik ve Spor Bayramı'],
    [`${year}-07-15`]: ['15 Temmuz Demokrasi ve Milli Birlik Günü'],
    [`${year}-08-30`]: ['30 Ağustos Zafer Bayramı'],
    [`${year}-10-29`]: ['29 Ekim Cumhuriyet Bayramı'],
  };
  const religiousByYear = {
    2026: {
      '2026-03-19': ['Ramazan Bayramı 1. Gün'],
      '2026-03-20': ['Ramazan Bayramı 2. Gün'],
      '2026-03-21': ['Ramazan Bayramı 3. Gün'],
      '2026-05-27': ['Kurban Bayramı 1. Gün'],
      '2026-05-28': ['Kurban Bayramı 2. Gün'],
      '2026-05-29': ['Kurban Bayramı 3. Gün'],
      '2026-05-30': ['Kurban Bayramı 4. Gün'],
    },
    2027: {
      '2027-03-09': ['Ramazan Bayramı 1. Gün'],
      '2027-03-10': ['Ramazan Bayramı 2. Gün'],
      '2027-03-11': ['Ramazan Bayramı 3. Gün'],
      '2027-05-17': ['Kurban Bayramı 1. Gün'],
      '2027-05-18': ['Kurban Bayramı 2. Gün'],
      '2027-05-19': ['Kurban Bayramı 3. Gün'],
      '2027-05-20': ['Kurban Bayramı 4. Gün'],
    },
    2028: {
      '2028-02-26': ['Ramazan Bayramı 1. Gün'],
      '2028-02-27': ['Ramazan Bayramı 2. Gün'],
      '2028-02-28': ['Ramazan Bayramı 3. Gün'],
      '2028-05-05': ['Kurban Bayramı 1. Gün'],
      '2028-05-06': ['Kurban Bayramı 2. Gün'],
      '2028-05-07': ['Kurban Bayramı 3. Gün'],
      '2028-05-08': ['Kurban Bayramı 4. Gün'],
    }
  };
  const holidayMap = { ...fixedEvents, ...(religiousByYear[year] || {}) };

  const pushNotification = (n) => {
    setNotifications((prev) => [{ id: `${Date.now()}-${Math.random()}`, read: false, ts: Date.now(), ...n }, ...prev].slice(0, 60));
    try {
      if (!soundEnabled) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 920;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(soundVolume, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.stop(ctx.currentTime + 0.2);
    } catch {}
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!calendarOpen) return;
    const onDocDown = (e) => {
      if (!calendarRef.current) return;
      if (!calendarRef.current.contains(e.target)) setCalendarOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [calendarOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    // Most browsers ignore (or auto-deny) a permission prompt that isn't
    // triggered by a user gesture -- firing this unconditionally on mount
    // just burned the one real prompt opportunity on page load instead of
    // the user's first actual interaction with the dashboard.
    const requestOnce = () => {
      Notification.requestPermission().catch(() => {});
      window.removeEventListener('pointerdown', requestOnce);
      window.removeEventListener('keydown', requestOnce);
    };
    window.addEventListener('pointerdown', requestOnce, { once: true });
    window.addEventListener('keydown', requestOnce, { once: true });
    return () => {
      window.removeEventListener('pointerdown', requestOnce);
      window.removeEventListener('keydown', requestOnce);
    };
  }, []);

  // pushNotification/notifyDevice/normalizeText/t are recreated every render
  // (pushNotification closes over soundEnabled/soundVolume, t over lang) --
  // mirrored here so the socket-registration effect below can read the
  // latest ones from a ref instead of listing lang/soundEnabled/soundVolume
  // as effect deps, which previously tore down and re-registered every
  // socket listener (and the actual sock.on/off calls, not just this
  // closure) on every language switch or volume-slider drag.
  const liveHandlersRef = useRef();
  liveHandlersRef.current = { t, pushNotification, notifyDevice, normalizeText };

  // Offline Mode (Settings > Bağlantı) -- app-wide user override, distinct
  // from the native connectivity state DesktopSyncBadge reflects. Tracked
  // here so the socket-connect gate below and the weather widget can both
  // read it live.
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());

  // Extracted so both the mount effect below and the aq:app-mode-reconnect
  // listener (B.3 reconciliation) can (re)connect the socket the same way.
  // Kept current via a ref (mirrors liveHandlersRef just above) so the
  // reconnect listener -- registered once -- always reads the latest
  // user.isAdmin/nickname/userCode without needing `user` in its own deps.
  const connectDashboardSocket = () => {
    const socketIdentity = user.isAdmin ? 'BOLD' : (user.nickname || user.userCode);
    return connectSocket(socketIdentity, getToken());
  };
  const connectDashboardSocketRef = useRef(connectDashboardSocket);
  connectDashboardSocketRef.current = connectDashboardSocket;

  // All the sock.on(...) registration a freshly-connected socket needs,
  // extracted out of the mount effect below so the aq:app-mode-reconnect
  // handler can attach the exact same listeners to a socket it (re)creates
  // after an Offline->Auto switch -- without this, a socket created outside
  // the mount effect would silently receive no broadcast/chat/notification/
  // auth:blocked/analysis events at all. Returns a detach function. Kept
  // current via a ref (mirrors connectDashboardSocketRef) so the
  // reconnect listener always attaches with the latest closures.
  const attachSocketListeners = (sock) => {
    const onBroadcast = (data) => {
      const { t, pushNotification, notifyDevice, normalizeText } = liveHandlersRef.current;
      const me = user.nickname || user.userCode;
      if (data.from === me) return;
      if (data?.initiator && data.initiator === me) return;
      const fromText = normalizeText(data.from);
      const msgText = normalizeText(data.message);
      setEmergencyToast({ ...data, from: fromText, message: msgText });
      pushNotification({
        type: 'emergency',
        title: t('emergencyBroadcastTitle'),
        body: `${fromText}: ${msgText || ''}`,
        action: 'open-emergency-chat',
      });
      notifyDevice(t('emergencyBroadcastTitle'), `${fromText}: ${msgText || ''}`);
      setTimeout(() => setEmergencyToast(null), 8000);
    };
    const onChatReceive = (data) => {
      const { t, pushNotification, notifyDevice } = liveHandlersRef.current;
      if (data.from === (user.nickname || user.userCode)) return;
      pushNotification({
        type: 'chat',
        title: t('newMessageTitle'),
        body: `${data.from}: ${data.message || ''}`,
        action: 'open-emergency-chat',
        targetUser: data.from,
      });
      notifyDevice(t('newMessageTitle'), `${data.from}: ${data.message || ''}`);
    };
    const onSystemNotification = (data) => {
      if (!data) return;
      const { t, pushNotification, notifyDevice } = liveHandlersRef.current;
      const me = user.nickname || user.userCode;
      if (data.initiator && me && data.initiator === me) return;
      pushNotification({
        type: 'system',
        title: t('systemNoticeTitle'),
        body: data.body || t('newSystemEvent'),
        action: data.action || 'home',
      });
      notifyDevice(t('systemNoticeTitle'), data.body || t('newSystemEvent'));
    };
    const onBlocked = () => {
      // A blocked user must not be able to relaunch and silently get back
      // in via the persisted native session either -- same fix as logout()
      // above, arguably more important here since this is an admin-forced
      // removal, not the user's own choice. This is forget-device (not
      // just logoutSession): an admin block should also revoke this
      // device's offline-login authorization, not merely end the current
      // session.
      logoutRequest();
      if (isNativeApp) nativeAuth.forgetDevice().catch(() => {});
      setJWT(null);
      setLocalAuthUser(null);
      clearLocalChatHistory();
      disconnectSocket();
      onLogout();
    };
    const onHardwareVerified = (data) => {
      if (!data) return;
      const { t, pushNotification, notifyDevice } = liveHandlersRef.current;
      const ok = !!data.hardwareVerification;
      pushNotification({
        type: 'system',
        title: t('hardwareVerifiedTitle'),
        body: ok ? t('hardwareVerifiedBody') : t('hardwareVerifiedFailedBody'),
        action: 'history',
      });
      notifyDevice(t('hardwareVerifiedTitle'), ok ? t('hardwareVerifiedBody') : t('hardwareVerifiedFailedBody'));
    };
    const onAnalysisCompleted = (data) => {
      if (!data) return;
      const { t, pushNotification, notifyDevice } = liveHandlersRef.current;
      pushNotification({
        type: 'system',
        title: t('analysisCompletedTitle'),
        body: t('analysisCompletedBody'),
        action: 'history',
      });
      notifyDevice(t('analysisCompletedTitle'), t('analysisCompletedBody'));
    };
    sock.on('emergency:broadcast', onBroadcast);
    sock.on('chat:receive', onChatReceive);
    sock.on('notification:new', onSystemNotification);
    sock.on('auth:blocked', onBlocked);
    sock.on('analysis:hardwareVerified', onHardwareVerified);
    sock.on('analysis:completed', onAnalysisCompleted);
    return () => {
      sock.off('emergency:broadcast', onBroadcast);
      sock.off('chat:receive', onChatReceive);
      sock.off('notification:new', onSystemNotification);
      sock.off('auth:blocked', onBlocked);
      sock.off('analysis:hardwareVerified', onHardwareVerified);
      sock.off('analysis:completed', onAnalysisCompleted);
    };
  };
  const attachSocketListenersRef = useRef(attachSocketListeners);
  attachSocketListenersRef.current = attachSocketListeners;
  // Tracks whichever detach function is currently "live" (from the mount
  // effect below, or from a later aq:app-mode-reconnect reattachment) so
  // whichever code disconnects/reconnects the socket can always tear down
  // exactly the listeners that are actually attached right now.
  const socketDetachRef = useRef(() => {});

  // Live-flips: dropping into Offline Mode mid-session disconnects an
  // already-connected socket immediately rather than waiting for the next
  // mount, and detaches this component's listeners from it. Switching back
  // to Auto does NOT reconnect here -- that only happens via the explicit
  // aq:app-mode-reconnect event ConnectionPanel dispatches (see
  // AppMenus.jsx), so a stale tab that merely observes someone else's mode
  // change doesn't also race to reconnect.
  useEffect(() => subscribeAppModePreference((mode) => {
    const offline = mode === 'offline';
    setAppModeOffline(offline);
    if (offline) {
      const sock = getSocket();
      if (sock && sock.connected) {
        socketDetachRef.current();
        socketDetachRef.current = () => {};
        disconnectSocket();
      }
    }
  }), []);

  useEffect(() => {
    const onReconnect = () => {
      let sock = getSocket();
      if (!sock || !sock.connected) {
        sock = connectDashboardSocketRef.current();
        socketDetachRef.current();
        socketDetachRef.current = attachSocketListenersRef.current(sock);
      }
      if (!isNativeApp) return;
      // needsReauth()/forceSync() no-op (return undefined) on the web build
      // and mobile-web -- Promise.resolve() safely wraps that instead of
      // needing an isNativeApp branch inside the .then chain too.
      Promise.resolve(nativeAuth.needsReauth()).then((needsReauth) => {
        // A reauth prompt is ReauthBanner's job (it already polls/listens
        // for this independently) -- this just avoids kicking off a sync
        // that's guaranteed to fail with 401 while one is pending.
        if (!needsReauth) return nativeSync.forceSync();
      }).catch(() => {});
    };
    window.addEventListener('aq:app-mode-reconnect', onReconnect);
    return () => window.removeEventListener('aq:app-mode-reconnect', onReconnect);
  }, []);

  useEffect(() => {
    // Offline Mode: skip connecting at mount entirely. Switching back to
    // Auto later reconnects via the aq:app-mode-reconnect listener above,
    // not by re-running this effect (user.userCode hasn't changed).
    if (isAppModeOffline()) return undefined;
    const sock = connectDashboardSocketRef.current();
    socketDetachRef.current = attachSocketListenersRef.current(sock);
    return () => {
      socketDetachRef.current();
      socketDetachRef.current = () => {};
    };
  }, [user.userCode]);

  useEffect(() => {
    const nickname = user.nickname || user.userCode;
    if (!nickname) return;
    if (!isMobileApp && !navigator.geolocation) return;

    // Live location is shared with the personnel radar (admin view) and used
    // for the local-weather widget below — it is not required for the rest
    // of the app, so it's opt-in and asked for explicitly rather than
    // starting silently as soon as the dashboard mounts.
    const consentKey = 'bqi_location_consent';
    let consent = localStorage.getItem(consentKey);
    if (consent === null) {
      const granted = window.confirm(liveHandlersRef.current.t('locationConsentPrompt'));
      consent = granted ? 'granted' : 'denied';
      localStorage.setItem(consentKey, consent);
    }
    if (consent !== 'granted') return;

    const sock = getSocket();
    if (!sock) return;

    const emitLocation = (coords) => {
      const lat = Number(coords?.latitude);
      const lng = Number(coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      setMyCoords({ lat, lng });
      // Konum cihaz içinde kullanılabilir -- GPS watch keeps running, only
      // the cloud emit is suppressed while Offline Mode is on.
      if (isAppModeOffline()) return;
      sock.emit('location:update', { lat, lng });
    };

    // On Android, go through the native Geolocation plugin instead of the
    // WebView's own navigator.geolocation: the native plugin makes Android
    // show its own OS permission dialog (this app's name + icon), where
    // navigator.geolocation would instead trigger the WebView's per-origin
    // geolocation prompt, which shows the app's raw hosting URL. Every
    // other platform (web, desktop) keeps using navigator.geolocation.
    if (isMobileApp) {
      return mobileGeolocation.watchPosition(emitLocation, {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 30000,
      });
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => emitLocation(position.coords),
      () => {},
      {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 30000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  // t (used only for the one-time consent prompt above) is read from
  // liveHandlersRef instead of the closure, so a language switch doesn't
  // tear down and restart the GPS watch for no functional reason.
  }, [user.nickname, user.userCode]);

  useEffect(() => {
    // Weather is an online-only service (proxied through the backend, see
    // below) -- Offline Mode short-circuits it entirely rather than letting
    // it fail silently against a suspended connection.
    if (appModeOffline) { setLiveTemp(null); setTempLoading(false); return; }
    if (!myCoords?.lat || !myCoords?.lng) return;
    let cancelled = false;

    const loadTemp = async () => {
      try {
        setTempLoading(true);
        // Proxied through the backend rather than calling Open-Meteo directly
        // from the browser, so user coordinates aren't sent to a third-party
        // service straight from the client on every session.
        const data = await api.weatherCurrent(myCoords.lat, myCoords.lng);
        if (!cancelled && Number.isFinite(data?.temperature)) setLiveTemp(data.temperature);
      } catch {} finally {
        if (!cancelled) setTempLoading(false);
      }
    };

    loadTemp();
    const timer = setInterval(loadTemp, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [myCoords?.lat, myCoords?.lng, appModeOffline]);

  useEffect(() => {
    const onVoiceNav = (e) => {
      const view = e?.detail?.view;
      if (view === 'analysis') {
        if (e?.detail?.category === 'siber') {
          navigate('/cyber-analysis');
          return;
        }
        setActiveCategory(e?.detail?.category || null);
        setView('analysis');
      } else if (view === 'home') {
        setView('home');
      } else if (view === 'history') {
        setHistoryOpen(true);
      } else if (view === 'chat') {
        setVoiceChatOpen(true);
      } else if (view === 'guide-open') {
        setGuideOpen(true);
      } else if (view === 'guide-close') {
        setGuideOpen(false);
      } else if (view === 'emergency-open') {
        window.dispatchEvent(new CustomEvent('aq:emergency:open'));
      }
    };
    window.addEventListener('aq:navigate', onVoiceNav);
    return () => window.removeEventListener('aq:navigate', onVoiceNav);
  }, []);

  useEffect(() => {
    const onLogoutCmd = () => logout();
    window.addEventListener('aq:logout', onLogoutCmd);
    return () => window.removeEventListener('aq:logout', onLogoutCmd);
  }, []);

  // "siber" is the one category whose content is a full admin panel
  // (Assets/Scans/Findings/Reports/Engines/Quantum tabs, see
  // CyberAnalysisContent.jsx) rather than the generic analysis wizard --
  // too much for AnalysisView's centered, narrower container, so it
  // navigates to the full-width standalone /cyber-analysis route instead
  // of rendering inline like every other category. Never a new tab/window
  // and never BCI's separate standalone UI (bci/ui) -- the browser stays in
  // BQI the whole time, using the same BQI session (SSO).
  const startAnalysis = (cat) => {
    if (cat === 'siber') { navigate('/cyber-analysis'); return; }
    setActiveCategory(cat);
    setView('analysis');
  };

  // item 8's native session refactor moved the persisted JWT out of
  // localStorage into the platform's own secure store (Electron's
  // safeStorage-encrypted file / Capacitor's native session manager),
  // restored on every launch via hydrateNativeSession(). This handler used
  // to only clear the in-memory copy (setJWT(null)) -- the secure store
  // itself was never told to clear, so a relaunch after logout silently
  // restored the old session and skipped the login screen entirely.
  // nativeAuth.logoutSession() is the same IPC/native call LoginPage's own
  // passkey/session flows already use to clear that store for real. Unlike
  // forgetDevice() below, this preserves the device's offline-login
  // authorization -- the same account can offline-login again on this
  // device without a fresh online round-trip.
  const logout = () => {
    fullLogout();
    onLogout();
  };

  // "Bu Cihazı Unut" (Settings > Security) -- fully revokes this device's
  // offline-login authorization, not just the active session. A fresh
  // online login is required before offline login works again on this
  // device. Mirrors logout() above, swapping in nativeAuth.forgetDevice().
  const forgetDevice = () => {
    logoutRequest();
    if (isNativeApp) nativeAuth.forgetDevice().catch(() => {});
    setJWT(null);
    setLocalAuthUser(null);
    clearLocalChatHistory();
    disconnectSocket();
    onLogout();
  };

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('aq:context', {
      detail: { page: `dashboard-${view}`, category: activeCategory },
    }));
  }, [view, activeCategory]);

  useEffect(() => {
    const dispatch = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

    registerActions('dashboard', buildDashboardVoiceActions({
      setView,
      setActiveCategory,
      setHistoryOpen,
      setVoiceChatOpen,
      setGuideOpen,
      setJWT,
      disconnectSocket,
      onLogout,
      performLogout: logout,
      dispatch,
      setPendingAnalysis,
      setSettingsOpen,
      setMenuOpen,
      setInfoPanel,
      setNotifOpen,
      setSidebarCollapsed,
      setUserMgmtOpen,
      setLang,
      isAdmin: !!user.isAdmin,
    }));

    return () => unregisterActions('dashboard');
  }, [onLogout, user.isAdmin, setLang]);

  return (
    <div className="quantum-bg min-h-screen flex flex-col relative">
      <header className="relative z-20 px-3 sm:px-6 py-3 bg-navy-light/80 backdrop-blur border-b border-cyan-300/30 hud-panel overflow-visible">
        <div className="flex flex-wrap items-center justify-between gap-2 md:gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <motion.div
            animate={{ scale: [0.98, 1.04, 0.98], filter: ['brightness(.94)', 'brightness(1.08)', 'brightness(.94)'] }}
            transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
            className="w-11 h-11 sm:w-12 sm:h-12 shrink-0 rounded-lg border border-cyan-300/30 bg-cyan-400/5 overflow-hidden"
          >
            <img src="/bqi-logo.png" alt="BQI" className="w-full h-full object-contain" />
          </motion.div>
          <div>
            <h1 className="font-display text-cyan-50 text-base sm:text-lg tracking-[0.28em] sm:tracking-[0.34em] whitespace-nowrap">BQI</h1>
            <p className="font-display font-medium text-[11px] sm:text-[13px] text-cyan-100/60 tracking-[0.13em] sm:tracking-[0.18em] uppercase whitespace-nowrap">Bold Quantum Intelligence</p>
          </div>
          <span className="text-xs sm:text-sm font-serif text-cyan-200 hidden sm:inline md:hidden max-w-[130px] lg:max-w-[170px] truncate">{user.isAdmin ? 'BOLD' : (user.nickname || user.userCode || 'BOLD')}</span>
        </div>

        <div className="flex items-center justify-end gap-1 flex-nowrap overflow-visible">
          <DesktopSyncBadge />
          <div className="relative" ref={calendarRef}>
            <button
              onClick={() => setCalendarOpen((v) => !v)}
              className="btn-depth header-control h-[28px] sm:h-[30px] px-3 py-2 rounded text-xs tracking-widest font-display flex items-center gap-1.5 shrink-0"
              title={t('calendarTooltip')}
            >
              <Clock3 className="w-3.5 h-3.5" />
              <span className="text-xs font-serif hidden sm:inline">{liveDate}</span>
              <span className="text-xs font-serif">{liveTime}</span>
              <span className="text-xs font-serif inline-flex items-center gap-1 border border-cyan-300/30 rounded px-1.5 py-0.5" title={appModeOffline ? t('weatherOfflineModeUnavailable') : t('tempTooltip')}>
                <Thermometer className="w-3 h-3" />
                {appModeOffline ? '—' : (tempLoading && liveTemp === null ? '...' : (liveTemp === null ? '' : `${liveTemp}°C`))}
              </span>
              <CalendarDays className="w-3.5 h-3.5" />
            </button>
            {calendarOpen && (
              <div className="absolute top-full right-0 mt-2 z-[85] w-72 rounded-lg border border-cyan-300/30 bg-[#061326]/95 backdrop-blur p-3 shadow-xl">
                <div className="flex items-center justify-between mb-2">
                  <button onClick={() => { const d = new Date(viewMonth); d.setMonth(d.getMonth() - 1); setViewMonth(d); setSelectedDay(null); }} className="text-cyan-300 hover:text-cyan-100 px-2" aria-label={t('prevMonth')}>‹</button>
                  <div className="text-cyan-100 text-xs tracking-widest uppercase">{monthLabel}</div>
                  <button onClick={() => { const d = new Date(viewMonth); d.setMonth(d.getMonth() + 1); setViewMonth(d); setSelectedDay(null); }} className="text-cyan-300 hover:text-cyan-100 px-2" aria-label={t('nextMonth')}>›</button>
                </div>
                <div className="grid grid-cols-7 gap-1 mb-1">{daysShort.map((d) => (<div key={d} className="text-xs text-cyan-300/80 text-center font-serif">{d}</div>))}</div>
                <div className="grid grid-cols-7 gap-1">{calendarCells.map((day, idx) => { const isToday = day && day === now.getDate() && viewMonth.getMonth() === now.getMonth() && viewMonth.getFullYear() === now.getFullYear(); const key = day ? formatYmd(viewMonth.getFullYear(), viewMonth.getMonth(), day) : null; const hasHoliday = !!(key && holidayMap[key]); const isSelected = day && selectedDay === day; return (<button type="button" key={`${idx}-${day || 'x'}`} onClick={() => day && setSelectedDay(day)} className={`h-7 rounded text-[14px] flex items-center justify-center font-serif relative ${day ? (isSelected ? 'bg-cyan-500/25 text-cyan-100 border border-cyan-300/50' : isToday ? 'bg-gold/30 text-gold border border-gold/40' : 'text-gold/90 bg-white/5') : 'bg-transparent'}`} disabled={!day}>{day || ''}{hasHoliday && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-400" />}</button>); })}</div>
              </div>
            )}
          </div>
          <button onClick={() => setVoiceChatOpen(true)} title={t('voiceConsultTooltip')}
            className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 sm:px-3 py-0 rounded text-xs tracking-widest font-display flex items-center gap-1.5 shrink-0">
            <Mic className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">{t('voiceConsult')}</span>
          </button>
          <button onClick={() => setHistoryOpen(true)} title={t('historyTooltip')}
            className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 sm:px-3 py-0 rounded text-xs tracking-widest font-display flex items-center gap-1.5 shrink-0">
            <History className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">{t('history')}</span>
          </button>
          <button
            onClick={() => {
              setNotifOpen((v) => !v);
              setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
            }}
            className="btn-depth header-control h-[28px] sm:h-[30px] relative px-2.5 py-2 rounded shrink-0"
            title={t('notificationsTooltip')}
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-xs leading-4 text-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
          <div className="border-l border-gold/30 pl-2 flex items-center gap-2 shrink-0">
            <span className="text-xs 2xl:text-sm font-serif text-cyan-200 hidden xl:inline max-w-[150px] 2xl:max-w-[220px] truncate">{user.isAdmin ? 'BOLD' : (user.nickname || user.userCode || 'BOLD')}</span>
            {user.isAdmin && (
              <button onClick={() => setUserMgmtOpen(true)} className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 py-2 rounded" title="Kullanıcı Yönetimi" aria-label="Kullanıcı Yönetimi">
                <Users className="w-4 h-4" />
              </button>
            )}
            <button onClick={() => setMenuOpen((v) => !v)} className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 py-2 rounded" title={t('menuTooltip')} aria-label={t('menuTooltip')}>
              <MenuIcon className="w-4 h-4" />
            </button>
            <button onClick={() => setSettingsOpen((v) => !v)} className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 py-2 rounded" title={t('settingsTooltip')} aria-label={t('settingsTooltip')}>
              <SettingsIcon className="w-4 h-4" />
            </button>
            <button onClick={logout} className="btn-depth header-control h-[28px] sm:h-[30px] px-2.5 py-2 rounded" title={t('logout')}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        </div>
      </header>

      <div className="flex-1 flex relative z-10 overflow-hidden">
        <CategorySidebar
          activeCategory={activeCategory}
          onSelect={startAnalysis}
          onHome={() => setView('home')}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        />

        <main className="flex-1 overflow-auto relative" onClick={() => { if (notifOpen) setNotifOpen(false); }}>
          <AnimatePresence mode="wait">
            {view === 'home' && (
              <motion.div key="home" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <HomeView isAdmin={!!user.isAdmin} onOpenRadar={() => setRadarOpen(true)} />
              </motion.div>
            )}

            {view === 'analysis' && (
              <motion.div key="analysis" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="p-3 sm:p-6">
                <AnalysisView category={activeCategory} onCategoryChange={startAnalysis} pendingAnalysis={pendingAnalysis} onPendingAnalysisApplied={() => setPendingAnalysis(null)} />
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>

      <AppFooter />

      <EmergencyButton authenticated={true} user={user} />

      <DesktopConflictModal lang={lang} />
      <ReauthBanner onLogout={logout} lang={lang} />

      <AnimatePresence>
        {voiceChatOpen && <VoiceChatModal onClose={() => setVoiceChatOpen(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {historyOpen && <HistoryModal onClose={() => setHistoryOpen(false)} title={t('pastAnalyses')} />}
      </AnimatePresence>
      <AnimatePresence>
        {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} t={t} lang={lang} />}
      </AnimatePresence>
      <AnimatePresence>
        {menuOpen && (
          <MenuPanel
            t={t}
            onClose={() => setMenuOpen(false)}
            onOpenGuide={() => { setGuideOpen(true); setMenuOpen(false); }}
            onOpenInfo={(panel) => { setInfoPanel(panel); setMenuOpen(false); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            t={t}
            lang={lang}
            setLang={setLang}
            onClose={() => setSettingsOpen(false)}
            soundEnabled={soundEnabled}
            setSoundEnabled={setSoundEnabled}
            soundVolume={soundVolume}
            setSoundVolume={setSoundVolume}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            onOpenGuide={() => { setGuideOpen(true); setSettingsOpen(false); }}
            onForgetDevice={forgetDevice}
            authenticated
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {infoPanel && <InfoModal panel={infoPanel} t={t} onClose={() => setInfoPanel(null)} />}
      </AnimatePresence>
      {radarOpen && <RadarModal onClose={() => setRadarOpen(false)} lang={lang} />}
      <AnimatePresence>
        {userMgmtOpen && <UserManagementModal onClose={() => setUserMgmtOpen(false)} lang={lang} />}
      </AnimatePresence>

      <AnimatePresence>
        {emergencyToast && (
          <motion.div initial={{ y: -20, opacity: 0, scale: 0.96 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: -20, opacity: 0, scale: 0.96 }}
            className="fixed inset-x-0 top-1/2 -translate-y-1/2 z-50 w-[92vw] sm:w-[min(92vw,560px)] mx-auto">
            <div
              className="bg-crimson/95 border border-red-400 rounded-md p-2 sm:p-4 shadow-2xl emergency-pulse cursor-pointer"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('aq:emergency:open', { detail: { forceChat: true } }));
                setEmergencyToast(null);
              }}
            >
              <div className="flex items-start gap-3">
                <span className="text-sm sm:text-2xl">!</span>
                <div className="flex-1">
                  <div className="text-xs sm:text-sm text-red-200 mb-0.5 sm:mb-1">{emergencyToast.from}:</div>
                  <div className="text-xs sm:text-base text-white font-medium whitespace-pre-wrap leading-snug">{emergencyToast.message}</div>
                </div>
                <button onClick={() => setEmergencyToast(null)} className="text-red-200 hover:text-white text-xs sm:text-base">X</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {notifOpen && (
          <>
            <motion.button
              type="button"
              aria-label={t('closeNotificationsTooltip')}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setNotifOpen(false)}
              className="fixed inset-0 z-[69] bg-transparent cursor-default"
            />
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="fixed top-16 right-3 sm:right-6 z-[70] w-[92vw] sm:w-[420px] max-h-[60vh] overflow-auto border border-cyan-300/30 rounded-lg bg-[#061326]/95 backdrop-blur p-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-2 py-1">
              <div className="text-[14px] tracking-widest uppercase text-cyan-200">{t('notificationCenterTitle')}</div>
              <button onClick={() => setNotifOpen(false)} className="text-cyan-200/70 hover:text-cyan-100" title={t('closeNotificationsTooltip')}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {notifications.length === 0 && (
              <p className="text-xs text-gold/60 px-2 py-3">{t('noNotificationsYet')}</p>
            )}
            <div className="flex items-center gap-2 px-2 py-1">
              <select value={notifFilter} onChange={(e) => setNotifFilter(e.target.value)} className="bg-[#0b1d34] border border-cyan-300/30 text-cyan-100 text-[14px] rounded px-2 py-1">
                <option value="all">{t('filterAll')}</option>
                <option value="chat">{t('filterChat')}</option>
                <option value="emergency">{t('filterEmergency')}</option>
                <option value="system">{t('homeSystem')}</option>
              </select>
              <button onClick={() => setSoundEnabled((v) => !v)} className="text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2 py-1" title={t('toggleSoundTooltip')}>
                {soundEnabled ? t('soundOnLabel') : t('soundOffLabel')}
              </button>
              <input type="range" min="0.02" max="0.2" step="0.01" value={soundVolume} onChange={(e) => setSoundVolume(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              {notifications.filter((n) => notifFilter === 'all' || n.type === notifFilter).map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (n.action === 'home') setView('home');
                    if (n.action === 'history') setView('history');
                    if (n.action === 'open-emergency-chat') window.dispatchEvent(new CustomEvent('aq:emergency:open', { detail: { targetUser: n.targetUser, forceChat: true } }));
                    setNotifOpen(false);
                  }}
                  className={`w-full text-left rounded border px-2.5 py-2 ${n.read ? 'border-white/10 bg-white/5' : 'border-cyan-400/40 bg-cyan-500/10'}`}
                >
                  <div className="text-xs text-cyan-100">{n.title}</div>
                  <div className="text-[14px] text-gold/80 mt-0.5 line-clamp-2">{n.body}</div>
                </button>
              ))}
            </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}


function HistoryModal({ onClose, title }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[66] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <motion.div initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }} onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-5xl h-[90vh] sm:h-[85vh] overflow-auto hud-panel rounded-t-2xl sm:rounded-xl p-3 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-cyan-100 font-display tracking-widest text-sm sm:text-lg">{title}</h3>
          <button onClick={onClose} className="text-cyan-100/70 hover:text-cyan-100"><X className="w-5 h-5" /></button>
        </div>
        <HistoryView showTitle={false} />
      </motion.div>
    </motion.div>
  );
}

function VoiceChatModal({ onClose }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[67] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <motion.div initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }} onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-6xl h-[92vh] sm:h-[88vh] overflow-hidden hud-panel rounded-t-2xl sm:rounded-xl">
        <VoiceChat onClose={onClose} />
      </motion.div>
    </motion.div>
  );
}

