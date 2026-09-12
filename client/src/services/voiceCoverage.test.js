import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAction, getActionsForAI, registerActions, unregisterActions } from './voiceActionRegistry.js';
import { buildDashboardVoiceActions } from './dashboardVoiceActions.js';

const REQUIRED_UNIVERSAL_ACTIONS = ['ui_activate', 'ui_set_value', 'ui_select', 'ui_scroll', 'ui_key', 'ui_focus'];
const REQUIRED_SEMANTIC_ACTIONS = [
  'navigate_home', 'navigate_analysis', 'start_analysis', 'navigate_history', 'close_history', 'new_analysis',
  'open_voice_chat', 'close_voice_chat', 'open_guide', 'close_guide',
  'logout', 'open_emergency', 'set_analysis_title', 'set_analysis_prompt',
  'generate_analysis', 'toggle_quantum', 'download_analysis', 'download_analysis_pdf', 'share_analysis', 'reset_analysis',
  'set_analysis_depth', 'set_analysis_priority', 'wizard_next', 'wizard_back', 'wizard_goto_step',
  'open_settings', 'close_settings', 'set_language', 'set_theme',
  'open_menu', 'close_menu', 'open_about', 'open_mission', 'open_contact', 'close_info',
  'open_notifications', 'close_notifications', 'expand_sidebar', 'collapse_sidebar',
];
const REQUIRED_ADMIN_ACTIONS = ['open_user_management', 'close_user_management'];

const scope = '__voice_coverage_gate__';
afterEach(() => unregisterActions(scope));

const baseDeps = () => ({
  setView: vi.fn(),
  setActiveCategory: vi.fn(),
  setHistoryOpen: vi.fn(),
  setVoiceChatOpen: vi.fn(),
  setGuideOpen: vi.fn(),
  setJWT: vi.fn(),
  disconnectSocket: vi.fn(),
  onLogout: vi.fn(),
  dispatch: vi.fn(),
  setPendingAnalysis: vi.fn(),
  setSettingsOpen: vi.fn(),
  setMenuOpen: vi.fn(),
  setInfoPanel: vi.fn(),
  setNotifOpen: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  setUserMgmtOpen: vi.fn(),
  setLang: vi.fn(),
});

// Builds the actual DashboardPage actions with mock deps, so this file tests
// what the app really registers — not a hand-copied list that can drift.
function registerRealDashboardActions(extra = {}) {
  const deps = { ...baseDeps(), ...extra };
  const actions = buildDashboardVoiceActions(deps);
  registerActions(scope, actions);
  return deps;
}

describe('Voice Control Coverage Gate', () => {
  it('exposes the complete universal UI control primitive set', () => {
    const names = new Set(getActionsForAI().map((action) => action.name));
    for (const name of REQUIRED_UNIVERSAL_ACTIONS) expect(names.has(name), `Missing universal voice action: ${name}`).toBe(true);
  });

  it('registers and advertises every required semantic action DashboardPage actually exposes', () => {
    registerRealDashboardActions();
    const advertised = new Set(getActionsForAI().map((action) => action.name));
    for (const name of REQUIRED_SEMANTIC_ACTIONS) {
      expect(advertised.has(name), `Semantic voice action is not advertised: ${name}`).toBe(true);
    }
    // Catches names removed/renamed in DashboardPage that this gate doesn't know about yet.
    for (const action of buildDashboardVoiceActions(baseDeps())) {
      expect(REQUIRED_SEMANTIC_ACTIONS.includes(action.name), `Undocumented semantic voice action: ${action.name}`).toBe(true);
    }
  });

  it('only registers/advertises admin actions (user management) for an admin session', () => {
    const nonAdminNames = new Set(buildDashboardVoiceActions(baseDeps()).map((a) => a.name));
    for (const name of REQUIRED_ADMIN_ACTIONS) {
      expect(nonAdminNames.has(name), `Admin action leaked to a non-admin voice registration: ${name}`).toBe(false);
    }
    const adminNames = new Set(buildDashboardVoiceActions({ ...baseDeps(), isAdmin: true }).map((a) => a.name));
    for (const name of REQUIRED_ADMIN_ACTIONS) {
      expect(adminNames.has(name), `Admin action missing from an admin voice registration: ${name}`).toBe(true);
    }
  });

  it('actually invokes the real DashboardPage handler for each required action', () => {
    const deps = registerRealDashboardActions();

    expect(executeAction('navigate_home', {})).toBe(true);
    expect(deps.setView).toHaveBeenCalledWith('home');

    expect(executeAction('navigate_analysis', { category: 'enerji' })).toBe(true);
    expect(deps.setActiveCategory).toHaveBeenCalledWith('enerji');
    expect(deps.setView).toHaveBeenCalledWith('analysis');

    expect(executeAction('start_analysis', { category: 'enerji', depth: 'derin', quantum: true })).toBe(true);
    expect(deps.setActiveCategory).toHaveBeenCalledWith('enerji');
    expect(deps.setView).toHaveBeenCalledWith('analysis');
    expect(deps.setPendingAnalysis).toHaveBeenCalledWith({ depth: 'derin', quantum: true, prompt: undefined, title: undefined });

    expect(executeAction('navigate_history', {})).toBe(true);
    expect(deps.setHistoryOpen).toHaveBeenCalledWith(true);

    expect(executeAction('new_analysis', {})).toBe(true);
    expect(deps.setActiveCategory).toHaveBeenCalledWith(null);

    expect(executeAction('open_voice_chat', {})).toBe(true);
    expect(deps.setVoiceChatOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_voice_chat', {})).toBe(true);
    expect(deps.setVoiceChatOpen).toHaveBeenCalledWith(false);

    expect(executeAction('open_guide', {})).toBe(true);
    expect(deps.setGuideOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_guide', {})).toBe(true);
    expect(deps.setGuideOpen).toHaveBeenCalledWith(false);

    expect(executeAction('logout', {})).toBe(true);
    expect(deps.setJWT).toHaveBeenCalledWith(null);
    expect(deps.disconnectSocket).toHaveBeenCalled();
    expect(deps.onLogout).toHaveBeenCalled();

    expect(executeAction('open_emergency', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:emergency:open', {});

    expect(executeAction('set_analysis_title', { value: 'Rapor' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:set', { field: 'title', value: 'Rapor' });

    expect(executeAction('set_analysis_prompt', { value: 'Brief' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:set', { field: 'prompt', value: 'Brief' });

    expect(executeAction('generate_analysis', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:generate', {});

    expect(executeAction('toggle_quantum', { mode: 'off' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:quantum', { mode: 'off' });

    expect(executeAction('download_analysis', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:download', {});

    expect(executeAction('reset_analysis', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:reset', {});

    expect(executeAction('set_analysis_depth', { value: 'derin' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:set', { field: 'depth', value: 'derin' });

    expect(executeAction('wizard_next', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:wizard:next', {});

    expect(executeAction('wizard_back', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:wizard:back', {});

    expect(executeAction('open_settings', {})).toBe(true);
    expect(deps.setSettingsOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_settings', {})).toBe(true);
    expect(deps.setSettingsOpen).toHaveBeenCalledWith(false);

    expect(executeAction('close_history', {})).toBe(true);
    expect(deps.setHistoryOpen).toHaveBeenCalledWith(false);

    expect(executeAction('download_analysis_pdf', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:downloadPdf', {});

    expect(executeAction('share_analysis', {})).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:share', {});

    expect(executeAction('set_analysis_priority', { value: 'yuksek' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:set', { field: 'priority', value: 'yuksek' });

    expect(executeAction('wizard_goto_step', { step: '3' })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:wizard:goto', { step: 3 });

    expect(executeAction('set_language', { value: 'de' })).toBe(true);
    expect(deps.setLang).toHaveBeenCalledWith('de');

    expect(executeAction('open_menu', {})).toBe(true);
    expect(deps.setMenuOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_menu', {})).toBe(true);
    expect(deps.setMenuOpen).toHaveBeenCalledWith(false);

    expect(executeAction('open_about', {})).toBe(true);
    expect(deps.setInfoPanel).toHaveBeenCalledWith('about');

    expect(executeAction('open_mission', {})).toBe(true);
    expect(deps.setInfoPanel).toHaveBeenCalledWith('mission');

    expect(executeAction('open_contact', {})).toBe(true);
    expect(deps.setInfoPanel).toHaveBeenCalledWith('contact');

    expect(executeAction('close_info', {})).toBe(true);
    expect(deps.setInfoPanel).toHaveBeenCalledWith(null);

    expect(executeAction('open_notifications', {})).toBe(true);
    expect(deps.setNotifOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_notifications', {})).toBe(true);
    expect(deps.setNotifOpen).toHaveBeenCalledWith(false);

    expect(executeAction('expand_sidebar', {})).toBe(true);
    expect(deps.setSidebarCollapsed).toHaveBeenCalledWith(false);

    expect(executeAction('collapse_sidebar', {})).toBe(true);
    expect(deps.setSidebarCollapsed).toHaveBeenCalledWith(true);
  });

  it('invokes the real admin-only handlers when registered for an admin session', () => {
    const deps = registerRealDashboardActions({ isAdmin: true });

    expect(executeAction('open_user_management', {})).toBe(true);
    expect(deps.setUserMgmtOpen).toHaveBeenCalledWith(true);

    expect(executeAction('close_user_management', {})).toBe(true);
    expect(deps.setUserMgmtOpen).toHaveBeenCalledWith(false);
  });

  it('keeps the complete advertised action surface uniquely named and documented', () => {
    registerRealDashboardActions();
    const actions = getActionsForAI();
    const names = actions.map((action) => action.name);
    expect(new Set(names).size, 'Duplicate voice action names make AI routing ambiguous').toBe(names.length);
    for (const action of actions) {
      expect(action.name?.trim(), 'Voice action without a name').toBeTruthy();
      expect(action.description?.trim(), `Voice action ${action.name} has no description`).toBeTruthy();
      expect(action.params && typeof action.params === 'object', `Voice action ${action.name} has invalid params`).toBe(true);
    }
  });
});
