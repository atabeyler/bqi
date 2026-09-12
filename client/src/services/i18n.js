// Backward-compatible facade over the i18next-based translation system
// (src/services/i18next.js, src/locales/{lang}/{ns}.json). Kept so every
// existing `import { t, localeFor, translations, ... } from './i18n.js'`
// call site across the app - and i18n.test.js - keeps working unchanged;
// new code should prefer useLang() from langContext.jsx, which wraps the
// same i18next instance for use inside React components.
import i18next, { NAMESPACES, SUPPORTED_LANGS } from './i18next.js';

export { SUPPORTED_LANGS };

// Pure, synchronous t(lang, key, vars?): looks the key up across every
// namespace for the given language, regardless of which namespace file it
// lives in, so callers never need to know or pass a namespace. Falls back
// to EN (the canonical language) and finally to the raw key if nothing
// matches, same contract as the old flat-object lookup. The optional third
// argument supports {{var}} interpolation (e.g. spoken confirmations that
// need to embed a category name) -- additive, existing 2-arg call sites
// are unaffected.
export function t(lang, key, vars) {
  return i18next.t(key, { lng: SUPPORTED_LANGS.includes(lang) ? lang : 'en', ns: NAMESPACES, fallbackNS: NAMESPACES, ...(vars || {}) });
}

const LOCALE_MAP = { tr: 'tr-TR', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', ar: 'ar-SA' };

// Shared BCP-47 locale tag for Intl.DateTimeFormat/toLocaleString() calls
// throughout the app, so date/time formatting follows the selected UI
// language for all 5 supported languages instead of only branching tr/en.
export function localeFor(lang) {
  return LOCALE_MAP[lang] || 'tr-TR';
}

// Flat per-language key->string view, reconstructed from the namespaced
// resources, for the couple of call sites (and i18n.test.js) that inspect
// the whole dictionary at once rather than looking up one key via t().
function buildFlatTranslations() {
  const flat = {};
  for (const lang of SUPPORTED_LANGS) {
    flat[lang] = {};
    for (const ns of NAMESPACES) {
      const bundle = i18next.getResourceBundle(lang, ns) || {};
      for (const [key, value] of Object.entries(bundle)) {
        if (key === 'reportTitleExamples' || key === 'guideModules') continue; // nested, not flat strings
        flat[lang][key] = value;
      }
    }
  }
  return flat;
}
export const translations = buildFlatTranslations();

// Per-category report-title placeholder examples (analysis namespace) and
// the in-app usage-guide content (common namespace) are structured,
// per-language data rather than flat strings, so they're nested inside
// their namespace JSON instead of going through t(). Re-exported here with
// their original shape so existing call sites (AnalysisView.jsx,
// AppMenus.jsx) don't need to change.
export const reportTitleExamples = Object.fromEntries(
  SUPPORTED_LANGS.map((lang) => [lang, i18next.getResourceBundle(lang, 'analysis')?.reportTitleExamples || {}])
);
export const guideModules = Object.fromEntries(
  SUPPORTED_LANGS.map((lang) => [lang, i18next.getResourceBundle(lang, 'common')?.guideModules || []])
);
