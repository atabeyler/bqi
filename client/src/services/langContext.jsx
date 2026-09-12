import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import i18next, { NAMESPACES, SUPPORTED_LANGS } from './i18next.js';

const LangContext = createContext();

export { SUPPORTED_LANGS };
const RTL_LANGS = new Set(['ar']);

// Single source of truth for which supported languages render right-to-left,
// so no component hardcodes its own `lang === 'ar'` check.
export function isRtl(langCode) {
  return RTL_LANGS.has(langCode);
}

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const saved = localStorage.getItem('bqi_lang');
    return SUPPORTED_LANGS.includes(saved) ? saved : 'tr';
  });

  const setLang = (next) => {
    if (!SUPPORTED_LANGS.includes(next)) return;
    setLangState(next);
    localStorage.setItem('bqi_lang', next);
  };

  // Kept for the few call sites (voice commands) that only ever toggle
  // between Turkish and English.
  const switchLang = () => setLang(lang === 'tr' ? 'en' : 'tr');

  // getFixedT returns a t() bound to the exact language passed in, resolved
  // against every namespace - independent of i18next's own "active language"
  // (set asynchronously below via changeLanguage), so switching languages
  // updates displayed text on the very next render with no lag.
  const t = useMemo(() => i18next.getFixedT(lang, NAMESPACES), [lang]);
  const dir = isRtl(lang) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    i18next.changeLanguage(lang);
  }, [lang, dir]);

  useEffect(() => {
    const onSet = (e) => {
      const next = e?.detail?.lang;
      if (SUPPORTED_LANGS.includes(next)) setLang(next);
    };
    window.addEventListener('aq:lang:set', onSet);
    return () => window.removeEventListener('aq:lang:set', onSet);
  }, []);

  return (
    <LangContext.Provider value={{ lang, dir, setLang, switchLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
