import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en.js';
import tr from './locales/tr.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import ar from './locales/ar.js';

// Zero-dependency i18n for the BCI admin UI (deliberately not react-i18next --
// this app is small enough that a flat key->string map per language plus a
// single interpolation helper covers it, without adding a runtime dependency
// to a standalone, independently-deployed image). English is the canonical
// source language; every other language falls back to it for a missing key.
export const SUPPORTED_LANGS = ['en', 'tr', 'fr', 'de', 'ar'];
const RESOURCES = { en, tr, fr, de, ar };
const RTL_LANGS = new Set(['ar']);
const STORAGE_KEY = 'bci_ui_lang';

export function enumLabel(t, group, value) {
  if (value == null) return '—';
  return t(`${group}_${String(value).toLowerCase()}`);
}

export function apiErrorLabel(t, error) {
  const code = error?.data?.reason || error?.data?.error || error?.message;
  const known = new Set([
    'invalid_request', 'request_failed', 'asset_not_found', 'report_not_found',
    'report_not_found_or_already_archived', 'job_not_found',
    'job_not_found_or_already_terminal', 'job_not_found_or_already_archived',
    'no_executable_engine', 'engine_not_healthy', 'capability_unavailable',
    'posture_snapshot_required', 'forbidden', 'unauthorized',
  ]);
  return known.has(code) ? t(`apiError_${code}`) : t('apiError_generic');
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED_LANGS.includes(saved) ? saved : 'en';
    } catch {
      return 'en';
    }
  });

  const setLang = (next) => {
    if (!SUPPORTED_LANGS.includes(next)) return;
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode etc -- non-fatal */ }
  };

  const dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const t = useMemo(() => {
    return (key, vars) => {
      const value = RESOURCES[lang]?.[key] ?? RESOURCES.en[key] ?? key;
      return interpolate(value, vars);
    };
  }, [lang]);

  return (
    <LangContext.Provider value={{ lang, setLang, dir, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
