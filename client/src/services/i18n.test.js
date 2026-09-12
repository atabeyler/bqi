import { describe, it, expect } from 'vitest';
import { t, translations } from './i18n.js';

const LANGS = ['tr', 'en', 'de', 'fr', 'ar'];

describe('t (translation function)', () => {
  it('returns a key defined for tr', () => {
    expect(t('tr', 'quantumMode')).toBe('KUANTUM OLASILIK MODU');
  });

  it('returns a key defined for en', () => {
    expect(t('en', 'quantumMode')).toBe('QUANTUM PROBABILITY MODE');
  });

  it('falls back to en for an unsupported language', () => {
    expect(t('xx', 'quantumMode')).toBe(t('en', 'quantumMode'));
  });

  it('returns a key defined for de', () => {
    expect(t('de', 'quantumMode')).toBe('QUANTENWAHRSCHEINLICHKEITSMODUS');
  });

  it('returns a key defined for fr', () => {
    expect(t('fr', 'quantumMode')).toBe('MODE DE PROBABILITÉ QUANTIQUE');
  });

  it('returns a key defined for ar', () => {
    expect(t('ar', 'quantumMode')).toBe('وضع الاحتمالية الكمية');
  });

  it('returns the key itself when undefined in every language', () => {
    expect(t('tr', 'no-such-key')).toBe('no-such-key');
  });

  it('defines the exact same set of keys in every language', () => {
    // Regression guard: a language missing a key it has elsewhere silently
    // falls back to Turkish for just that one string, which is easy to miss
    // in review since every *other* string in that language still looks
    // fine. This turns that into a hard failure instead.
    const [first, ...rest] = LANGS;
    const baseKeys = Object.keys(translations[first]).sort();
    for (const lang of rest) {
      expect(Object.keys(translations[lang]).sort(), `${lang} key set`).toEqual(baseKeys);
    }
  });

  it('defines errAllProvidersFailed (non-Turkish-fallback) in every language', () => {
    // Regression test: this key exists specifically so a server error that
    // isn't routed through i18n (ALL_AI_PROVIDERS_FAILED) can still show a
    // properly localized message instead of raw Turkish text leaking into
    // an app the user has set to another language.
    for (const lang of LANGS) {
      const value = t(lang, 'errAllProvidersFailed');
      expect(value, `${lang} errAllProvidersFailed`).not.toBe('errAllProvidersFailed');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
