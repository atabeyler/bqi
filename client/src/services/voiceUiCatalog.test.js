import { describe, it, expect } from 'vitest';
import { matchUiCatalogAction, SCREENS, UI_CATALOG } from './voiceUiCatalog.js';

describe('voiceUiCatalog', () => {
  it('matches a known navigation phrase to its catalog entry', () => {
    const entry = matchUiCatalogAction('ana ekrana dön', SCREENS.DASHBOARD_ANALYSIS);
    expect(entry?.action).toBe('navigate_home');
  });

  it('matches across languages for the same target', () => {
    expect(matchUiCatalogAction('go home', SCREENS.DASHBOARD_HOME)?.action).toBe('navigate_home');
    expect(matchUiCatalogAction('zur startseite', SCREENS.DASHBOARD_HOME)?.action).toBe('navigate_home');
  });

  it('returns null for unrecognized text', () => {
    expect(matchUiCatalogAction('bugün hava nasıl', SCREENS.DASHBOARD_HOME)).toBeNull();
  });

  it('flags logout as requiring confirmation', () => {
    const entry = matchUiCatalogAction('çıkış yap', SCREENS.DASHBOARD_HOME);
    expect(entry?.action).toBe('logout');
    expect(entry?.requiresConfirmation).toBe(true);
  });

  it('every catalog entry declares a non-empty validOn and synonym set', () => {
    for (const entry of UI_CATALOG) {
      expect(entry.action?.trim()).toBeTruthy();
      expect(Array.isArray(entry.validOn) && entry.validOn.length > 0).toBe(true);
      expect(Object.keys(entry.synonyms || {}).length).toBeGreaterThan(0);
    }
  });

  it('disambiguates open/close phrase pairs by picking the more specific (longer) match', () => {
    expect(matchUiCatalogAction('ayarları kapat', SCREENS.DASHBOARD_HOME)?.action).toBe('close_settings');
    expect(matchUiCatalogAction('ayarlara git', SCREENS.DASHBOARD_HOME)?.action).toBe('open_settings');
    expect(matchUiCatalogAction('sohbeti kapat', SCREENS.DASHBOARD_HOME)?.action).toBe('close_voice_chat');
    expect(matchUiCatalogAction('sohbet', SCREENS.DASHBOARD_HOME)?.action).toBe('open_voice_chat');
  });

  it('resolves the new menu/info/notification/sidebar navigation actions', () => {
    expect(matchUiCatalogAction('menuyu ac', SCREENS.DASHBOARD_HOME)?.action).toBe('open_menu');
    expect(matchUiCatalogAction('hakkimizda', SCREENS.DASHBOARD_HOME)?.action).toBe('open_about');
    expect(matchUiCatalogAction('bildirimleri ac', SCREENS.DASHBOARD_HOME)?.action).toBe('open_notifications');
    expect(matchUiCatalogAction('kenar cubugunu daralt', SCREENS.DASHBOARD_HOME)?.action).toBe('collapse_sidebar');
  });

  it('marks admin-only entries with requiredPermission so callers can gate them', () => {
    const radar = UI_CATALOG.find((e) => e.action === 'open_user_management');
    expect(radar?.requiredPermission).toBe('admin');
  });
});
