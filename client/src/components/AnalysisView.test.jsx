import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalysisView from './AnalysisView.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api } from '../services/api.js';
import { setAppMode } from '../services/appModePreference.js';

vi.mock('../services/api.js', () => ({
  api: {
    generateAnalysis: vi.fn(async () => ({
      success: true, content: '# Rapor', docxBase64: btoa('docx-bytes'), pdfBase64: btoa('pdf-bytes'), quantumMode: false,
    })),
    scenarioDeepDive: vi.fn(async () => ({ content: '# Alt senaryo' })),
  },
}));

// ConsultChat has its own extensive test coverage (ConsultChat.test.jsx) and
// its own set of mocked dependencies -- stub it here so AnalysisView tests
// only exercise AnalysisView's own logic (the "danisma" category just
// delegates to it wholesale).
vi.mock('./ConsultChat.jsx', () => ({ default: () => <div>ConsultChat stub</div> }));

function renderView(props = {}) {
  return render(<LangProvider><AnalysisView category={null} onCategoryChange={vi.fn()} {...props} /></LangProvider>);
}

// The wizard now gates the prompt/quantum-mode/generate fields behind its
// 5-step flow (see AnalysisWizard.jsx) -- the prompt textarea lives on step
// 1, the quantum-mode toggle on step 3, and the actual "generate" button on
// step 5. Clicks "SONRAKİ" `times` times from whatever step is current.
function clickNext(times) {
  for (let i = 0; i < times; i++) {
    fireEvent.click(screen.getByRole('button', { name: /SONRAKİ/i }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
  localStorage.removeItem('bqi_lang');
  localStorage.removeItem('bqi_app_mode');
});

describe('AnalysisView', () => {
  it('shows the category picker when no category is selected', () => {
    const onCategoryChange = vi.fn();
    renderView({ category: null, onCategoryChange });
    fireEvent.click(screen.getByText('Savunma').closest('button'));
    expect(onCategoryChange).toHaveBeenCalledWith('savunma');
  });

  it('delegates to ConsultChat for the "danisma" category', () => {
    renderView({ category: 'danisma' });
    expect(screen.getByText('ConsultChat stub')).toBeInTheDocument();
  });

  it('hands the legacy inline "siber" category to the canonical route selector without rendering a second BCI UI', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onCategoryChange = vi.fn();
    renderView({ category: 'siber', onCategoryChange });
    await waitFor(() => expect(onCategoryChange).toHaveBeenCalledWith('siber'));
    expect(screen.queryByText('Yeni Analiz Başlat')).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('opens the new-analysis wizard for a selected category, with the generate button disabled until a prompt is entered', () => {
    renderView({ category: 'ekonomi' });
    expect(screen.getByText('Yeni Analiz Başlat')).toBeInTheDocument();
    clickNext(4);
    expect(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i })).toBeDisabled();
  });

  const WIZARD_TRANSLATIONS = {
    en: { title: 'Start New Analysis', step1: 'Analysis Info', category: 'Category', priority: 'Priority Level', cancel: 'CANCEL', next: 'NEXT' },
    de: { title: 'Neue Analyse starten', step1: 'Analyseinformationen', category: 'Kategorie', priority: 'Prioritätsstufe', cancel: 'ABBRECHEN', next: 'WEITER' },
    fr: { title: 'Démarrer une nouvelle analyse', step1: "Informations d'analyse", category: 'Catégorie', priority: 'Niveau de priorité', cancel: 'ANNULER', next: 'SUIVANT' },
    ar: { title: 'بدء تحليل جديد', step1: 'معلومات التحليل', category: 'الفئة', priority: 'مستوى الأولوية', cancel: 'إلغاء', next: 'التالي' },
  };

  it.each(Object.entries(WIZARD_TRANSLATIONS))('renders the wizard fully in %s when the language is switched, with no leftover Turkish labels', (lang, tx) => {
    localStorage.setItem('bqi_lang', lang);
    renderView({ category: 'ekonomi' });
    expect(screen.getByText(tx.title)).toBeInTheDocument();
    expect(screen.getAllByText(tx.step1).length).toBeGreaterThan(0);
    expect(screen.getByText(tx.category)).toBeInTheDocument();
    expect(screen.getByText(tx.priority)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tx.cancel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(tx.next, 'i') })).toBeInTheDocument();
    expect(screen.queryByText('Analiz Bilgileri')).not.toBeInTheDocument();
    expect(screen.queryByText('Kategori')).not.toBeInTheDocument();
    localStorage.removeItem('bqi_lang');
  });

  it('enables the generate button once a prompt is entered', () => {
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'test brief' } });
    clickNext(4);
    expect(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i })).not.toBeDisabled();
  });

  it('routes through the offline path (never calling the cloud API) when app-wide Offline Mode is on, even with connectivity reporting cloud-reachable', async () => {
    setAppMode('offline');
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'ekonomik brifing talebi' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));

    // Not a native app in this test environment, so there's no local engine
    // to fall back to either -- routeAnalysisGeneration throws instead of
    // ever calling cloudCall (api.generateAnalysis), which is exactly the
    // "effective offline flag" this exercises: forceLocalMode is false and
    // isNativeApp is false (so the old isOffline computation would have
    // been false too), yet the app-mode preference alone still routes away
    // from the cloud.
    await waitFor(() => expect(screen.getByText(/⚠/)).toBeInTheDocument());
    expect(api.generateAnalysis).not.toHaveBeenCalled();
  });

  it('generates a standard analysis and renders the markdown report', async () => {
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'ekonomik brifing talebi' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));

    await waitFor(() => expect(api.generateAnalysis).toHaveBeenCalled());
    expect(api.generateAnalysis.mock.calls[0][0]).toBe('ekonomi');
    expect(api.generateAnalysis.mock.calls[0][3]).toBe(false); // quantumMode off by default
    expect(api.generateAnalysis.mock.calls[0][10]).toBe('normal'); // priority default
    expect(api.generateAnalysis.mock.calls[0][11]).toBe('standart'); // depth default
    expect(api.generateAnalysis.mock.calls[0][12]).toBe('INTERNAL'); // dataClassification: ordinary category floor
    expect(await screen.findByText('Rapor')).toBeInTheDocument();
  });

  // Audit finding: the UI computed no classification at all for the
  // generate call, so a high-sensitivity category's attachments/analysis
  // request looked identical to an ordinary one by the time it reached the
  // API. classifyCategory() (services/classification.js) mirrors the
  // server's own classifyData() category floor.
  it('passes CONFIDENTIAL for a high-sensitivity category (savunma)', async () => {
    renderView({ category: 'savunma' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'savunma brifingi' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));

    await waitFor(() => expect(api.generateAnalysis).toHaveBeenCalled());
    expect(api.generateAnalysis.mock.calls[0][0]).toBe('savunma');
    expect(api.generateAnalysis.mock.calls[0][12]).toBe('CONFIDENTIAL');
  });

  it('passes quantumMode=true through to the API when the quantum toggle is checked', async () => {
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(2);
    fireEvent.click(screen.getByText('KUANTUM OLASILIK MODU'));
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: /KUANTUM OLASILIK ANALİZİ BAŞLAT/i }));

    await waitFor(() => expect(api.generateAnalysis).toHaveBeenCalled());
    expect(api.generateAnalysis.mock.calls[0][3]).toBe(true);
  });

  it('shows an error message when generation fails', async () => {
    api.generateAnalysis.mockRejectedValueOnce(new Error('sunucu hatasi'));
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));
    expect(await screen.findByText(/sunucu hatasi/)).toBeInTheDocument();
  });

  it('shows the quantum backend badge and lets the user reset after a quantum result', async () => {
    api.generateAnalysis.mockResolvedValueOnce({
      success: true,
      content: '# Kuantum Rapor',
      docxBase64: btoa('x'),
      quantumMode: true,
      quantum: { backend: 'qiskit-aer-simulator', qubits: 3, shots: 4096 },
      scenarios: [{ id: 'A', title: 'Senaryo A', quantumProbability: 42, llmEstimate: 40 }],
    });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(2);
    fireEvent.click(screen.getByText('KUANTUM OLASILIK MODU'));
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: /KUANTUM OLASILIK ANALİZİ BAŞLAT/i }));

    expect(await screen.findByText(/qiskit-aer-simulator/)).toBeInTheDocument();
    // Rendered twice -- once in the ScenarioPanel list, once as an axis label
    // in ScenarioComparisonChart (since this scenario has a quantumProbability).
    expect(screen.getAllByText('Senaryo A').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('YENİ ANALİZ'));
    expect(screen.queryByText(/qiskit-aer-simulator/)).not.toBeInTheDocument();
    // The wizard reopens automatically once the result is cleared (see
    // AnalysisView.jsx: it's shown whenever there is a category but no result).
    expect(screen.getByText('Yeni Analiz Başlat')).toBeInTheDocument();
  });

  it('drills into an alternative scenario and back', async () => {
    api.generateAnalysis.mockResolvedValueOnce({
      success: true,
      content: '# Kuantum Rapor',
      docxBase64: btoa('x'),
      quantumMode: true,
      scenarios: [
        { id: 'A', title: 'Senaryo A (Birincil)', quantumProbability: 42, llmEstimate: 40 },
        { id: 'B', title: 'Senaryo B', quantumProbability: 30, llmEstimate: 28 },
      ],
    });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(2);
    fireEvent.click(screen.getByText('KUANTUM OLASILIK MODU'));
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: /KUANTUM OLASILIK ANALİZİ BAŞLAT/i }));
    await waitFor(() => expect(screen.getAllByText('Senaryo B').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'ANALİZ ET' }));
    await waitFor(() => expect(api.scenarioDeepDive).toHaveBeenCalledWith('ekonomi', 'B', 'Senaryo B', 'tr'));
    expect(await screen.findByText('Alt senaryo')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Ana Rapora Dön'));
    expect(screen.queryByText('Alt senaryo')).not.toBeInTheDocument();
  });

  it('downloads the PDF as a client-side blob (no extra network call, since it comes back with the analysis)', async () => {
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));
    await screen.findByText('Rapor');

    fireEvent.click(screen.getByRole('button', { name: /\.PDF İNDİR/i }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('shares the report via the Web Share API when the platform supports file sharing', async () => {
    const shareMock = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: shareMock });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));
    await screen.findByText('Rapor');

    fireEvent.click(screen.getByRole('button', { name: /PAYLAŞ/i }));
    await waitFor(() => expect(shareMock).toHaveBeenCalled());
  });

  it('falls back to a plain download when sharing when the platform has no file-share support', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(4);
    fireEvent.click(screen.getByRole('button', { name: /DETAYLI ANALİZ RAPORU ÜRET/i }));
    await screen.findByText('Rapor');

    fireEvent.click(screen.getByRole('button', { name: /PAYLAŞ/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  it('shows a visible warning when quantum mode was requested but the circuit computation failed', async () => {
    api.generateAnalysis.mockResolvedValueOnce({
      success: true, content: '# Rapor', docxBase64: btoa('x'), pdfBase64: btoa('x'),
      quantumMode: true, quantumWarning: 'Kuantum devre hesaplaması başarısız oldu — gösterilen olasılıklar YZ tahminleridir.',
    });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(2);
    fireEvent.click(screen.getByText('KUANTUM OLASILIK MODU'));
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: /KUANTUM OLASILIK ANALİZİ BAŞLAT/i }));

    expect(await screen.findByText(/Kuantum devre hesaplaması başarısız oldu/)).toBeInTheDocument();
  });

  it('shows no warning when quantum mode succeeds', async () => {
    api.generateAnalysis.mockResolvedValueOnce({
      success: true, content: '# Rapor', docxBase64: btoa('x'), pdfBase64: btoa('x'),
      quantumMode: true, quantumWarning: null,
    });
    renderView({ category: 'ekonomi' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'brief' } });
    clickNext(2);
    fireEvent.click(screen.getByText('KUANTUM OLASILIK MODU'));
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: /KUANTUM OLASILIK ANALİZİ BAŞLAT/i }));

    await screen.findByText('Rapor');
    expect(screen.queryByText(/başarısız/)).not.toBeInTheDocument();
  });
});

// Covers the voice-driven "start_analysis" flow: the wizard must actually
// open pre-populated with the category/depth/quantum/prompt a voice command
// resolved, not just at its defaults (see DashboardPage.jsx's
// pendingAnalysis + dashboardVoiceActions.js's start_analysis handler).
describe('AnalysisView: pendingAnalysis (voice-resolved start_analysis fields)', () => {
  it('pre-selects depth/quantum/prompt/title from a pending voice command and clears it once applied', () => {
    const onPendingAnalysisApplied = vi.fn();
    renderView({
      category: 'enerji',
      pendingAnalysis: { depth: 'derin', quantum: true, prompt: 'kritik enerji hattı değerlendirmesi', title: 'Sesli Rapor' },
      onPendingAnalysisApplied,
    });

    expect(onPendingAnalysisApplied).toHaveBeenCalled();

    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    expect(textarea.value).toBe('kritik enerji hattı değerlendirmesi');
    const titleInput = screen.getAllByRole('textbox').find((el) => el.tagName === 'INPUT');
    expect(titleInput.value).toBe('Sesli Rapor');

    // Step 3 (quantum) should already show quantum mode enabled.
    clickNext(2);
    expect(screen.getByText('KUANTUM OLASILIK MODU').closest('div[class*="cursor-pointer"]')).toHaveClass('bg-cyan-400/10');

    // Step 4 (depth) should already show "derin" selected.
    clickNext(1);
    expect(screen.getByText('Derin').closest('button')).toHaveClass('border-cyan-300/60');
  });

  it('ignores an invalid depth value instead of crashing', () => {
    renderView({ category: 'enerji', pendingAnalysis: { depth: 'not-a-real-depth' }, onPendingAnalysisApplied: vi.fn() });
    expect(screen.getByText('Yeni Analiz Başlat')).toBeInTheDocument();
  });
});

// Covers the previously dead dispatch('aq:analysis:*', ...) calls from
// dashboardVoiceActions.js (set_analysis_title/prompt, generate_analysis,
// toggle_quantum, download_analysis, reset_analysis) -- nothing listened
// for these window events before, so the corresponding voice commands had
// no effect on the actual wizard/analysis state.
describe('AnalysisView: aq:analysis:* voice event wiring', () => {
  it('applies aq:analysis:set (title/prompt) and aq:analysis:quantum events', () => {
    renderView({ category: 'enerji' });

    fireEvent(window, new CustomEvent('aq:analysis:set', { detail: { field: 'title', value: 'Voice Title' } }));
    fireEvent(window, new CustomEvent('aq:analysis:set', { detail: { field: 'prompt', value: 'voice brief text' } }));
    fireEvent(window, new CustomEvent('aq:analysis:quantum', { detail: { mode: 'on' } }));

    const titleInput = screen.getAllByRole('textbox').find((el) => el.tagName === 'INPUT');
    expect(titleInput.value).toBe('Voice Title');
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    expect(textarea.value).toBe('voice brief text');

    clickNext(2);
    expect(screen.getByText('KUANTUM OLASILIK MODU').closest('div[class*="cursor-pointer"]')).toHaveClass('bg-cyan-400/10');
  });

  it('triggers generate() through the aq:analysis:generate event', async () => {
    renderView({ category: 'enerji' });
    const textarea = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'voice-triggered brief' } });

    fireEvent(window, new CustomEvent('aq:analysis:generate'));

    await waitFor(() => expect(api.generateAnalysis).toHaveBeenCalled());
  });
});
