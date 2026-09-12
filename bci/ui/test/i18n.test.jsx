import { describe, it, expect } from 'vitest';
import en from '../src/i18n/locales/en.js';
import tr from '../src/i18n/locales/tr.js';
import fr from '../src/i18n/locales/fr.js';
import de from '../src/i18n/locales/de.js';
import ar from '../src/i18n/locales/ar.js';
import { apiErrorLabel, enumLabel, SUPPORTED_LANGS } from '../src/i18n/LangContext.jsx';

const LOCALES = { en, tr, fr, de, ar };

describe('bci/ui i18n locale parity', () => {
  it('SUPPORTED_LANGS matches the set of shipped locale files', () => {
    expect(new Set(SUPPORTED_LANGS)).toEqual(new Set(Object.keys(LOCALES)));
  });

  it('every non-English locale has exactly the same keys as the canonical English source', () => {
    const enKeys = new Set(Object.keys(en));
    for (const [lang, dict] of Object.entries(LOCALES)) {
      if (lang === 'en') continue;
      const dictKeys = new Set(Object.keys(dict));
      const missing = [...enKeys].filter((k) => !dictKeys.has(k));
      const extra = [...dictKeys].filter((k) => !enKeys.has(k));
      expect(missing, `${lang} is missing keys: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `${lang} has extra keys not in en: ${extra.join(', ')}`).toEqual([]);
    }
  });

  it('every value is a non-empty string', () => {
    for (const [lang, dict] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${lang}.${key} should be a string`).toBe('string');
        expect(value.length, `${lang}.${key} should not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('localizes known machine codes instead of exposing raw values', () => {
    for (const dict of Object.values(LOCALES)) {
      const t = (key) => dict[key] ?? key;
      expect(enumLabel(t, 'scanStatus', 'FAILED')).not.toBe('FAILED');
      expect(apiErrorLabel(t, { data: { reason: 'posture_snapshot_required' } })).not.toContain('posture_snapshot_required');
    }
  });
});
