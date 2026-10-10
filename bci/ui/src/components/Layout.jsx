import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useLang, SUPPORTED_LANGS } from '../i18n/LangContext.jsx';

const NAV_ITEMS = [
  { to: '/', key: 'navDashboard', end: true },
  { to: '/assets', key: 'navAssets' },
  { to: '/scans', key: 'navScans' },
  { to: '/findings', key: 'navFindings' },
  { to: '/reports', key: 'navReports' },
  { to: '/engines', key: 'navEngines' },
  { to: '/quantum', key: 'navQuantum' },
  { to: '/decision', key: 'navDecision' },
];

const LANG_NAMES = { en: 'English', tr: 'Türkçe', fr: 'Français', de: 'Deutsch', ar: 'العربية' };

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const { t, lang, setLang } = useLang();

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <h1>BCI</h1>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {t(item.key)}
          </NavLink>
        ))}
        <NavLink to="/pentest">Authenticated Pentest</NavLink>
        <div className="controlled-proof-nav">
          {hasPermission('system:manage') ? (
            <NavLink to="/controlled-proof" className={({ isActive }) => `controlled-proof-link${isActive ? ' active' : ''}`}>
              {t('navControlledProof')}
            </NavLink>
          ) : (
            <span className="controlled-proof-link locked" title={t('systemAdminRequired')} aria-disabled="true">
              {t('navControlledProof')} · {t('lockedLabel')}
            </span>
          )}
        </div>
        <div style={{ marginTop: 'auto' }}>
          <select
            aria-label={t('languageLabel')}
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          >
            {SUPPORTED_LANGS.map((code) => <option key={code} value={code}>{LANG_NAMES[code]}</option>)}
          </select>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{user?.email}</div>
          <a className="logout" onClick={logout}>
            {t('logout')}
          </a>
        </div>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
