#!/usr/bin/env node
// Validates the i18next locale resources under client/src/locales/{lang}/{ns}.json:
//   - every file parses as valid JSON (catches a broken/malformed edit)
//   - every language defines the exact same key set as EN (the canonical
//     language, see client/src/services/i18next.js) within each namespace -
//     a key missing elsewhere falls back to EN at runtime rather than
//     breaking, but this catches the gap before it ships
//   - no value is empty in only SOME languages while non-empty in others
//     (an accidentally-cleared translation for just that language). A key
//     that's empty across every language is left alone here - that's a
//     dead/unused key, a separate cleanup, not a translation gap.
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '..', 'client', 'src', 'locales');

const CANONICAL_LANG = 'en';
const langs = readdirSync(localesDir).filter((f) => !f.startsWith('.'));
const problems = [];

function flattenStrings(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[path] = value;
    } else if (value && typeof value === 'object') {
      Object.assign(out, flattenStrings(value, path));
    }
  }
  return out;
}

if (!langs.includes(CANONICAL_LANG)) {
  problems.push(`Canonical language "${CANONICAL_LANG}" has no locales/${CANONICAL_LANG}/ directory.`);
} else {
  const namespaces = readdirSync(path.join(localesDir, CANONICAL_LANG))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  const parsed = {}; // parsed[lang][ns] = object
  for (const lang of langs) {
    parsed[lang] = {};
    for (const ns of namespaces) {
      const filePath = path.join(localesDir, lang, `${ns}.json`);
      let raw;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        problems.push(`Missing file: locales/${lang}/${ns}.json (present for ${CANONICAL_LANG})`);
        continue;
      }
      try {
        parsed[lang][ns] = JSON.parse(raw);
      } catch (e) {
        problems.push(`Broken JSON in locales/${lang}/${ns}.json: ${e.message}`);
      }
    }
  }

  for (const ns of namespaces) {
    const canonicalKeys = new Set(Object.keys(parsed[CANONICAL_LANG][ns] || {}));
    for (const lang of langs) {
      const nsData = parsed[lang]?.[ns];
      if (!nsData) continue; // already reported as missing/broken above
      const keys = new Set(Object.keys(nsData));
      const missing = [...canonicalKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !canonicalKeys.has(k));
      if (missing.length) problems.push(`locales/${lang}/${ns}.json is missing key(s) present in ${CANONICAL_LANG}: ${missing.join(', ')}`);
      if (extra.length) problems.push(`locales/${lang}/${ns}.json has key(s) not present in ${CANONICAL_LANG} (typo, or ${CANONICAL_LANG} needs updating): ${extra.join(', ')}`);
    }

    // Per-key, cross-language: flag a value that's blank in some languages
    // but filled in for others (an asymmetric gap), not a key that's blank
    // everywhere (a dead/unused key, out of scope for this check).
    const flatByLang = {};
    for (const lang of langs) {
      if (parsed[lang]?.[ns]) flatByLang[lang] = flattenStrings(parsed[lang][ns]);
    }
    for (const key of canonicalKeys) {
      const byLang = langs.filter((l) => flatByLang[l]).map((l) => [l, flatByLang[l][key]]);
      const blankLangs = byLang.filter(([, v]) => typeof v === 'string' && v.trim() === '').map(([l]) => l);
      const filledLangs = byLang.filter(([, v]) => typeof v === 'string' && v.trim() !== '');
      if (blankLangs.length && filledLangs.length) {
        problems.push(`locales/*/${ns}.json key "${key}" is blank in [${blankLangs.join(', ')}] but filled in for [${filledLangs.map(([l]) => l).join(', ')}]`);
      }
    }
  }
}

if (problems.length) {
  console.error('Locale check failed:');
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

const totalFiles = langs.length * readdirSync(path.join(localesDir, CANONICAL_LANG)).filter((f) => f.endsWith('.json')).length;
console.log(`Locale check OK: ${langs.length} languages, ${totalFiles} namespace files, all keys consistent with "${CANONICAL_LANG}".`);
