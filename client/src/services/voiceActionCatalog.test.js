import { describe, it, expect } from 'vitest';
import { ACTION_CATALOG, SCREENS, catalogEntry } from './voiceActionCatalog.js';
import { SUPPORTED_LANGS } from './i18n.js';
import { UI_CATALOG } from './voiceUiCatalog.js';

// Automated voice-coverage audit (requirement: UI capability -> semantic
// action -> voice metadata in all 5 languages -> handler -> test). This
// file is the "registry completeness" half of that chain: every action the
// app can register anywhere (dashboardVoiceActions.js, or a
// self-registering component like PersonnelRadar.jsx/EmergencyButton.jsx/
// HomeView.jsx) must have exactly one ACTION_CATALOG entry with real
// name/description/params/synonyms -- so a gap here is a gap CI catches,
// not a silent omission.
describe('voiceActionCatalog: registry completeness (single source of truth)', () => {
  it('has no duplicate action names', () => {
    const names = ACTION_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry has a name, non-empty description and a params object', () => {
    for (const entry of ACTION_CATALOG) {
      expect(entry.name?.trim(), 'catalog entry missing name').toBeTruthy();
      expect(entry.description?.trim(), `${entry.name}: missing description`).toBeTruthy();
      expect(entry.params && typeof entry.params === 'object', `${entry.name}: params must be an object`).toBe(true);
    }
  });

  it('every entry declares a non-empty validOn screen list', () => {
    for (const entry of ACTION_CATALOG) {
      expect(Array.isArray(entry.validOn) && entry.validOn.length > 0, `${entry.name}: missing validOn`).toBe(true);
      for (const screen of entry.validOn) {
        expect(Object.values(SCREENS).includes(screen), `${entry.name}: validOn references unknown screen "${screen}"`).toBe(true);
      }
    }
  });

  it('every entry has at least one voice synonym for all 5 supported languages (TR/EN/DE/FR/AR)', () => {
    const missing = [];
    for (const entry of ACTION_CATALOG) {
      for (const lang of SUPPORTED_LANGS) {
        const words = entry.synonyms?.[lang];
        if (!Array.isArray(words) || words.length === 0) missing.push(`${entry.name} (${lang})`);
      }
    }
    expect(missing, `Actions missing a voice synonym entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('flags logout as the confirmation-required destructive action, and nothing non-destructive as requiring confirmation', () => {
    expect(catalogEntry('logout')?.requiresConfirmation).toBe(true);
    for (const entry of ACTION_CATALOG) {
      if (entry.name === 'logout') continue;
      expect(entry.requiresConfirmation, `${entry.name} unexpectedly requires confirmation`).not.toBe(true);
    }
  });

  it('marks every admin-only capability with requiredPermission so RBAC gating is explicit, not implicit', () => {
    const expectedAdmin = ['open_user_management', 'close_user_management', 'open_radar', 'close_radar', 'refresh_briefing'];
    for (const name of expectedAdmin) {
      expect(catalogEntry(name)?.requiredPermission, `${name} should require the admin permission`).toBe('admin');
    }
  });

  it('every navMatch entry is reflected in the derived UI_CATALOG used for phrase navigation matching', () => {
    const navNames = new Set(ACTION_CATALOG.filter((e) => e.navMatch).map((e) => e.name));
    const uiNames = new Set(UI_CATALOG.map((e) => e.action));
    expect(uiNames).toEqual(navNames);
  });
});
