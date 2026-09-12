import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

// Namespace files, one per feature area, under src/locales/{lang}/{ns}.json.
// Split out of a single growing i18n.js so translators/reviewers can work on
// one screen's copy at a time instead of one 1000+ line file.
export const NAMESPACES = ['common', 'login', 'dashboard', 'analysis', 'admin'];
export const SUPPORTED_LANGS = ['tr', 'en', 'de', 'fr', 'ar'];

import trCommon from '../locales/tr/common.json';
import trLogin from '../locales/tr/login.json';
import trDashboard from '../locales/tr/dashboard.json';
import trAnalysis from '../locales/tr/analysis.json';
import trAdmin from '../locales/tr/admin.json';

import enCommon from '../locales/en/common.json';
import enLogin from '../locales/en/login.json';
import enDashboard from '../locales/en/dashboard.json';
import enAnalysis from '../locales/en/analysis.json';
import enAdmin from '../locales/en/admin.json';

import deCommon from '../locales/de/common.json';
import deLogin from '../locales/de/login.json';
import deDashboard from '../locales/de/dashboard.json';
import deAnalysis from '../locales/de/analysis.json';
import deAdmin from '../locales/de/admin.json';

import frCommon from '../locales/fr/common.json';
import frLogin from '../locales/fr/login.json';
import frDashboard from '../locales/fr/dashboard.json';
import frAnalysis from '../locales/fr/analysis.json';
import frAdmin from '../locales/fr/admin.json';

import arCommon from '../locales/ar/common.json';
import arLogin from '../locales/ar/login.json';
import arDashboard from '../locales/ar/dashboard.json';
import arAnalysis from '../locales/ar/analysis.json';
import arAdmin from '../locales/ar/admin.json';

const resources = {
  tr: { common: trCommon, login: trLogin, dashboard: trDashboard, analysis: trAnalysis, admin: trAdmin },
  en: { common: enCommon, login: enLogin, dashboard: enDashboard, analysis: enAnalysis, admin: enAdmin },
  de: { common: deCommon, login: deLogin, dashboard: deDashboard, analysis: deAnalysis, admin: deAdmin },
  fr: { common: frCommon, login: frLogin, dashboard: frDashboard, analysis: frAnalysis, admin: frAdmin },
  ar: { common: arCommon, login: arLogin, dashboard: arDashboard, analysis: arAnalysis, admin: arAdmin },
};

// EN is the canonical/fallback language: a key missing anywhere else in the
// resources above always resolves to its EN string rather than the app's
// default UI language (TR), so an incomplete translation never silently
// shows the wrong language's text.
i18next.use(initReactI18next).init({
  resources,
  lng: 'tr',
  fallbackLng: 'en',
  ns: NAMESPACES,
  defaultNS: 'common',
  // Callers use a flat t(key) with no namespace prefix (see langContext.jsx),
  // so every namespace is searched in this fixed order for each lookup.
  fallbackNS: NAMESPACES,
  interpolation: { escapeValue: false }, // React already escapes on render
  returnEmptyString: false,
  initImmediate: false, // resources are bundled, no async backend to await
});

export default i18next;
