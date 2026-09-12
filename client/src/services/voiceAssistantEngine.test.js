import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActions, unregisterActions, executePlan } from './voiceActionRegistry.js';
import { buildDashboardVoiceActions } from './dashboardVoiceActions.js';

const { processVoiceCommand, _resetVoiceEngineState } = await import('./voiceAssistantEngine.js');

const scope = '__engine_test__';

function register(deps = {}) {
  const merged = {
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
    ...deps,
  };
  registerActions(scope, buildDashboardVoiceActions(merged));
  return merged;
}

beforeEach(() => _resetVoiceEngineState());
afterEach(() => unregisterActions(scope));

describe('processVoiceCommand: fully local deterministic resolution (no network call)', () => {
  beforeEach(() => register());

  it('resolves a plain Turkish category+start command', async () => {
    const result = await processVoiceCommand('Savunma analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'start_analysis', params: { category: 'savunma', depth: 'standart', quantum: false } }]);
    expect(result.speak).toMatch(/Savunma/);
  });

  it('resolves energy analysis', async () => {
    const result = await processVoiceCommand('Enerji analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions[0]).toEqual({ action: 'start_analysis', params: { category: 'enerji', depth: 'standart', quantum: false } });
  });

  it('resolves a "yeni analiz oluştur" phrasing', async () => {
    const result = await processVoiceCommand('Enerji için yeni analiz oluştur', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions[0].params.category).toBe('enerji');
  });

  it('extracts depth from "derin ekonomi analizi yap"', async () => {
    const result = await processVoiceCommand('Derin ekonomi analizi aç', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions[0]).toEqual({ action: 'start_analysis', params: { category: 'ekonomi', depth: 'derin', quantum: false } });
  });

  it('extracts quantum=true from "kuantum destekli enerji analizi başlat"', async () => {
    const result = await processVoiceCommand('kuantum destekli enerji analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions[0]).toEqual({ action: 'start_analysis', params: { category: 'enerji', depth: 'standart', quantum: true } });
  });

  it('composes category + depth + quantum from a single multi-clause Turkish utterance', async () => {
    const result = await processVoiceCommand('Kuantum destekli derin savunma analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions[0]).toEqual({ action: 'start_analysis', params: { category: 'savunma', depth: 'derin', quantum: true } });
  });

  it('resolves an English natural phrasing', async () => {
    const result = await processVoiceCommand('start a deep defense analysis with quantum', { page: 'dashboard-analysis', lang: 'en' });
    expect(result.actions[0]).toEqual({ action: 'start_analysis', params: { category: 'savunma', depth: 'derin', quantum: true } });
  });

  it('resolves a German natural phrasing', async () => {
    const result = await processVoiceCommand('starte eine tiefe Verteidigungsanalyse', { page: 'dashboard-analysis', lang: 'de' });
    expect(result.actions[0].params).toEqual({ category: 'savunma', depth: 'derin', quantum: false });
  });

  it('resolves a French natural phrasing', async () => {
    const result = await processVoiceCommand('lancer une analyse économie approfondie', { page: 'dashboard-analysis', lang: 'fr' });
    expect(result.actions[0].params).toEqual({ category: 'ekonomi', depth: 'derin', quantum: false });
  });

  it('resolves an Arabic natural phrasing', async () => {
    const result = await processVoiceCommand('ابدأ تحليل الطاقة', { page: 'dashboard-analysis', lang: 'ar' });
    expect(result.actions[0].params.category).toBe('enerji');
  });

  it('asks for clarification instead of guessing when an analysis is requested with no recognizable category', async () => {
    const result = await processVoiceCommand('yeni analiz başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([]);
    expect(result.speak.length).toBeGreaterThan(0);
  });

  it('resolves the generic "not understood" response for gibberish, with no action taken', async () => {
    const result = await processVoiceCommand('bugün hava nasıl acaba', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([]);
  });
});

describe('processVoiceCommand: context-aware follow-ups on the analysis screen', () => {
  beforeEach(() => register());

  const ctx = { page: 'dashboard-analysis', lang: 'tr', category: 'savunma', wizardOpen: true, wizardStep: 4 };

  it('resolves a bare "Derin yap" against the active wizard, without repeating the category', async () => {
    const result = await processVoiceCommand('Derin yap', ctx);
    expect(result.actions).toEqual([{ action: 'set_analysis_depth', params: { value: 'derin' } }]);
  });

  it('resolves a bare "Kuantumu aç" against the active wizard', async () => {
    const result = await processVoiceCommand('Kuantumu aç', ctx);
    expect(result.actions).toEqual([{ action: 'toggle_quantum', params: { mode: 'on' } }]);
  });

  it('resolves "Sonraki" to wizard_next', async () => {
    const result = await processVoiceCommand('Sonraki', ctx);
    expect(result.actions).toEqual([{ action: 'wizard_next', params: {} }]);
  });

  it('resolves "Sıfırla" to reset_analysis', async () => {
    const result = await processVoiceCommand('Sıfırla', ctx);
    expect(result.actions).toEqual([{ action: 'reset_analysis', params: {} }]);
  });

  it('resolves a bare "Başlat" (no other slot matched) to generate_analysis', async () => {
    const result = await processVoiceCommand('Başlat', ctx);
    expect(result.actions).toEqual([{ action: 'generate_analysis', params: {} }]);
  });

  it('does nothing context-specific once the wizard is closed (result already shown)', async () => {
    const result = await processVoiceCommand('Derin yap', { ...ctx, wizardOpen: false });
    // No category/analysis word and no navigation match either -> falls
    // through to the generic "not understood" response.
    expect(result.actions).toEqual([]);
  });

  it('an explicit new category command still switches category even mid-wizard', async () => {
    const result = await processVoiceCommand('Enerji analizi başlat', ctx);
    expect(result.actions[0].params.category).toBe('enerji');
  });

  it('resolves a priority word against the active wizard', async () => {
    const result = await processVoiceCommand('önceliği yüksek yap', ctx);
    expect(result.actions).toEqual([{ action: 'set_analysis_priority', params: { value: 'yuksek' } }]);
  });

  it('resolves an explicit wizard step number ("3. adıma git")', async () => {
    const result = await processVoiceCommand('3. adıma git', ctx);
    expect(result.actions).toEqual([{ action: 'wizard_goto_step', params: { step: '3' } }]);
  });

  it('resolves "step 2" in English too', async () => {
    const result = await processVoiceCommand('go to step 2', { ...ctx, lang: 'en' });
    expect(result.actions).toEqual([{ action: 'wizard_goto_step', params: { step: '2' } }]);
  });
});

describe('processVoiceCommand: report download/share stay reachable once a result is on screen', () => {
  beforeEach(() => register());

  // wizardOpen flips false once a result exists (see AnalysisView.jsx) --
  // hasResult is what keeps these context-aware commands reachable.
  const resultCtx = { page: 'dashboard-analysis', lang: 'tr', category: 'enerji', wizardOpen: false, hasResult: true };

  it('resolves "raporu indir" to download_analysis', async () => {
    const result = await processVoiceCommand('raporu indir', resultCtx);
    expect(result.actions).toEqual([{ action: 'download_analysis', params: {} }]);
  });

  it('resolves "pdf olarak indir" to download_analysis_pdf, not the docx download', async () => {
    const result = await processVoiceCommand('pdf olarak indir', resultCtx);
    expect(result.actions).toEqual([{ action: 'download_analysis_pdf', params: {} }]);
  });

  it('resolves "raporu paylaş" to share_analysis', async () => {
    const result = await processVoiceCommand('raporu paylaş', resultCtx);
    expect(result.actions).toEqual([{ action: 'share_analysis', params: {} }]);
  });

  it('does nothing download/share-specific once wizardOpen is false and there is no result either', async () => {
    const result = await processVoiceCommand('raporu indir', { ...resultCtx, hasResult: false });
    expect(result.actions).toEqual([]);
  });
});

describe('processVoiceCommand: global language/theme preference commands (work from any screen)', () => {
  beforeEach(() => register());

  it('resolves "dili almanca yap" to set_language(de)', async () => {
    const result = await processVoiceCommand('dili almanca yap', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'set_language', params: { value: 'de' } }]);
  });

  it('resolves "switch to french" to set_language(fr)', async () => {
    const result = await processVoiceCommand('switch to french', { page: 'dashboard-home', lang: 'en' });
    expect(result.actions).toEqual([{ action: 'set_language', params: { value: 'fr' } }]);
  });

  it('resolves "koyu temaya geç" to set_theme(dark)', async () => {
    const result = await processVoiceCommand('koyu temaya geç', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'set_theme', params: { value: 'dark' } }]);
  });

  it('resolves "light mode" to set_theme(light)', async () => {
    const result = await processVoiceCommand('light mode', { page: 'dashboard-home', lang: 'en' });
    expect(result.actions).toEqual([{ action: 'set_theme', params: { value: 'light' } }]);
  });
});

describe('processVoiceCommand: regression -- category commands never cross-trigger an unrelated tab/action', () => {
  beforeEach(() => register());

  it('"Savunma analizi başlat" resolves to exactly the defense category, nothing else', async () => {
    const result = await processVoiceCommand('Savunma analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'start_analysis', params: { category: 'savunma', depth: 'standart', quantum: false } }]);
  });

  it('"Enerji analizi başlat" selects energy and never triggers an unrelated tab (e.g. history/"Tarih")', async () => {
    const result = await processVoiceCommand('Enerji analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'start_analysis', params: { category: 'enerji', depth: 'standart', quantum: false } }]);
    expect(result.actions.some((a) => a.action === 'navigate_history')).toBe(false);
    expect(result.actions.some((a) => a.action === 'navigate_home')).toBe(false);
  });

  it('"Derin kuantum destekli enerji analizi başlat" yields exactly category=energy, depth=deep, quantum=true', async () => {
    const result = await processVoiceCommand('Derin kuantum destekli enerji analizi başlat', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'start_analysis', params: { category: 'enerji', depth: 'derin', quantum: true } }]);
  });
});

describe('processVoiceCommand: catalog-driven navigation (no ui_activate DOM guessing)', () => {
  beforeEach(() => register());

  it('resolves "ana ekrana dön" to navigate_home', async () => {
    const result = await processVoiceCommand('ana ekrana dön', { page: 'dashboard-analysis', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'navigate_home', params: {} }]);
  });

  it('resolves "geçmiş" to navigate_history', async () => {
    const result = await processVoiceCommand('geçmişi aç', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'navigate_history', params: {} }]);
  });

  it('resolves "ayarlara git" to open_settings', async () => {
    const result = await processVoiceCommand('ayarlara git', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'open_settings', params: {} }]);
  });

  it('resolves "panele git" to navigate_analysis', async () => {
    const result = await processVoiceCommand('panele git', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'navigate_analysis', params: {} }]);
  });

  it('"geri dön" resolves to wizard_back while the wizard is open, and to navigate_home otherwise', async () => {
    const inWizard = await processVoiceCommand('geri dön', { page: 'dashboard-analysis', lang: 'tr', category: 'savunma', wizardOpen: true });
    expect(inWizard.actions).toEqual([{ action: 'wizard_back', params: {} }]);

    const onHome = await processVoiceCommand('geri dön', { page: 'dashboard-home', lang: 'tr' });
    expect(onHome.actions).toEqual([{ action: 'navigate_home', params: {} }]);
  });
});

describe('processVoiceCommand: logout requires spoken confirmation', () => {
  beforeEach(() => register());

  it('does not log out immediately -- it asks for confirmation first', async () => {
    const result = await processVoiceCommand('çıkış yap', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([]);
    expect(result.speak.length).toBeGreaterThan(0);
  });

  it('logs out only once the very next utterance confirms', async () => {
    await processVoiceCommand('çıkış yap', { page: 'dashboard-home', lang: 'tr' });
    const result = await processVoiceCommand('evet', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'logout', params: {} }]);
  });

  it('cancels instead of logging out when the follow-up declines', async () => {
    await processVoiceCommand('çıkış yap', { page: 'dashboard-home', lang: 'tr' });
    const result = await processVoiceCommand('hayır', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([]);
  });

  it('drops the pending confirmation and resolves a new unrelated command normally', async () => {
    await processVoiceCommand('çıkış yap', { page: 'dashboard-home', lang: 'tr' });
    const result = await processVoiceCommand('ana ekrana dön', { page: 'dashboard-home', lang: 'tr' });
    expect(result.actions).toEqual([{ action: 'navigate_home', params: {} }]);
  });
});

describe('multi-step action plans: executePlan short-circuits on a failed critical step', () => {
  it('executes every step in order when all succeed', () => {
    const deps = register();
    const results = executePlan([
      { action: 'navigate_analysis', params: { category: 'savunma' } },
      { action: 'toggle_quantum', params: { mode: 'on' } },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(deps.setActiveCategory).toHaveBeenCalledWith('savunma');
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:quantum', { mode: 'on' });
  });

  it('stops the plan after a critical step names an action that is not registered', () => {
    register();
    const results = executePlan([
      { action: 'start_analysis', params: { category: 'enerji' } },
      { action: 'not_a_real_action', params: {} },
      { action: 'toggle_quantum', params: { mode: 'off' } },
    ]);
    expect(results[0]).toEqual({ action: 'start_analysis', ok: true });
    expect(results[1].ok).toBe(false);
  });

  it('never triggers ui_activate as part of a validated critical plan', () => {
    const deps = register();
    const activateSpy = vi.fn();
    registerActions('__ui_activate_probe__', [{ name: 'probe_ui_activate_never_called', description: '', params: {}, handler: activateSpy }]);
    executePlan([{ action: 'start_analysis', params: { category: 'savunma', quantum: true } }]);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(deps.setPendingAnalysis).toHaveBeenCalledWith({ depth: undefined, quantum: true, prompt: undefined, title: undefined });
    unregisterActions('__ui_activate_probe__');
  });

  it('runs a locally-composed multi-action context plan (depth + quantum together)', () => {
    const deps = register();
    const results = executePlan([
      { action: 'set_analysis_depth', params: { value: 'derin' } },
      { action: 'toggle_quantum', params: { mode: 'on' } },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:set', { field: 'depth', value: 'derin' });
    expect(deps.dispatch).toHaveBeenCalledWith('aq:analysis:quantum', { mode: 'on' });
  });
});
