import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Sparkles, Download, Loader2, Atom, BrainCircuit, Database, Gauge, ShieldCheck,
  BarChart3, ArrowLeft, Share2, FileDown, Check, Clock, FileText, Image as ImageIcon
} from 'lucide-react';
import { CATEGORIES } from './CategorySidebar.jsx';
import { api } from '../services/api.js';
import { classifyCategory } from '../services/classification.js';
import { useLang } from '../services/langContext.jsx';
import { reportTitleExamples } from '../services/i18n.js';
import { base64ToBlob, downloadBlob, shareOrDownloadBlob } from '../services/shareFile.js';
import { buildLocalDocxBlob, buildLocalPdfBlob } from '../services/localExport.js';
import VoiceButton from './VoiceButton.jsx';
import ConsultChat from './ConsultChat.jsx';
import FileAttach, { describeStructuredUpload } from './FileAttach.jsx';
import { ScenarioComparisonChart, FraudRiskChart, OptimizerChart } from './QuantumCharts.jsx';
import { AnalysisWorkflow, ResultProvenance, ResultSourceBadge, DecisionPipelinePanel } from './AnalysisWorkflow.jsx';
import AnalysisWizard from './AnalysisWizard.jsx';
import EngineBadge from './EngineBadge.jsx';
import { DEPTH_IDS } from '../services/voiceIntentSchema.js';
import { isNativeApp, nativeAI, nativeAnalyses, nativeConnectivity } from '../services/nativeBridge.js';
import { routeAnalysisGeneration, AllEnginesUnavailableError } from '../services/analysisRouter.js';
import { ENGINE } from '../services/aiContract.js';
import { isLocalModeForced, subscribeLocalModePreference } from '../services/localModePreference.js';
import { isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';

const PANEL = 'rounded-lg border border-cyan-400/15 bg-[#031326]/80';

export default function AnalysisView({ category, onCategoryChange, pendingAnalysis = null, onPendingAnalysisApplied = () => {} }) {
  const { t, lang } = useLang();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [documentContexts, setDocumentContexts] = useState([]); // [{ filename, text }]
  const [imageFiles, setImageFiles] = useState([]);
  const [realTransactions, setRealTransactions] = useState(null); // { filename, transactions, warnings }
  const [realScenarios, setRealScenarios] = useState(null); // { filename, scenarios, warnings }
  const [realOptimization, setRealOptimization] = useState(null); // { filename, items, budgetPercent, warnings }
  const [quantumMode, setQuantumMode] = useState(false);
  const [priority, setPriority] = useState('normal');
  const [depth, setDepth] = useState('standart');
  // Lifted out of AnalysisWizard so voice commands can drive the wizard
  // step from outside it (see the aq:wizard:next/back listener below).
  const [wizardStep, setWizardStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingScenario, setLoadingScenario] = useState(null);
  const [result, setResult] = useState(null);
  const [scenarioResult, setScenarioResult] = useState(null);
  const [error, setError] = useState('');
  const [connectivity, setConnectivity] = useState('cloud');
  const [forceLocalMode, setForceLocalModeState] = useState(() => isLocalModeForced());
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());
  // App-wide Offline Mode (Settings > Bağlantı) ORs into the same effective
  // offline flag as forceLocalMode/connectivity -- it never mutates
  // forceLocalMode itself, it's purely an additional read-site condition.
  const isOffline = forceLocalMode || appModeOffline || (isNativeApp && connectivity === 'local');

  // Mirrors ConsultChat.jsx's connectivity subscription exactly -- both
  // components need the same "are we actually offline right now" signal
  // to route through the Analysis Router the same way.
  useEffect(() => {
    if (!isNativeApp) return;
    let cancelled = false;
    nativeConnectivity.getState().then((state) => { if (!cancelled) setConnectivity(state); }).catch(() => {});
    const unsubscribe = nativeConnectivity.onChange((state) => setConnectivity(state));
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => subscribeLocalModePreference(setForceLocalModeState), []);
  useEffect(() => subscribeAppModePreference((mode) => setAppModeOffline(mode === 'offline')), []);

  const generateRef = useRef(null);
  const downloadDocxRef = useRef(null);
  const downloadPdfRef = useRef(null);
  const shareRef = useRef(null);
  const resetRef = useRef(null);

  // Generation can run long enough (AI + quantum + docx/pdf, all in one
  // request) to outlive the user's patience -- if they close the wizard and
  // pick a new category (or the same one again) before the first request's
  // fetch finally settles (success or a late network error), that stale
  // settlement must not clobber whatever the user is looking at *now*.
  // generationIdRef is bumped on every generate() call (see below) so a late
  // settlement can recognize it's been superseded; bumping it here too, plus
  // clearing any leftover error/loading, means re-entering the wizard for a
  // fresh attempt never opens on a stale error from an abandoned earlier one.
  const generationIdRef = useRef(0);
  useEffect(() => {
    generationIdRef.current++;
    setError('');
    setLoading(false);
  }, [category]);

  // Applies category/depth/quantum/prompt/title a voice command (start_analysis)
  // resolved for the wizard. Runs on mount and whenever a fresh voice
  // command produces a new pending object -- this is the fix that actually
  // makes voice-driven analysis start with the right fields pre-selected
  // instead of just opening the wizard at its defaults.
  useEffect(() => {
    if (!pendingAnalysis) return;
    if (pendingAnalysis.depth && DEPTH_IDS.includes(pendingAnalysis.depth)) setDepth(pendingAnalysis.depth);
    if (typeof pendingAnalysis.quantum === 'boolean') setQuantumMode(pendingAnalysis.quantum);
    if (pendingAnalysis.prompt) setPrompt(pendingAnalysis.prompt);
    if (pendingAnalysis.title) setTitle(pendingAnalysis.title);
    onPendingAnalysisApplied();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnalysis]);

  // Wires up the voice-action dispatches from dashboardVoiceActions.js
  // (set_analysis_title/prompt, generate_analysis, toggle_quantum,
  // download_analysis, reset_analysis) -- these events were previously
  // dispatched with nothing listening for them.
  useEffect(() => {
    const onSet = (e) => {
      const { field, value } = e?.detail || {};
      if (field === 'title') setTitle(value ?? '');
      if (field === 'prompt') setPrompt((prev) => (value ? (prev ? prev + ' ' + value : value) : prev));
      if (field === 'depth' && DEPTH_IDS.includes(value)) setDepth(value);
      if (field === 'priority' && ['dusuk', 'normal', 'yuksek', 'kritik'].includes(value)) setPriority(value);
    };
    const onQuantum = (e) => setQuantumMode((e?.detail?.mode || 'on') !== 'off');
    const onGenerate = () => generateRef.current?.();
    const onDownload = () => downloadDocxRef.current?.();
    const onDownloadPdf = () => downloadPdfRef.current?.();
    const onShare = () => shareRef.current?.();
    const onReset = () => resetRef.current?.();
    // wizard_next/wizard_back (see dashboardVoiceActions.js) -- lets voice
    // commands ("Sonraki"/"Geri dön") drive the 5-step wizard from outside
    // it, the same way set_analysis_title/prompt already drive its fields.
    const onWizardNext = () => setWizardStep((s) => Math.min(5, s + 1));
    const onWizardBack = () => setWizardStep((s) => Math.max(1, s - 1));
    // wizard_goto_step -- jumps directly to a numbered step (1-5) instead
    // of stepping through wizard_next repeatedly.
    const onWizardGoto = (e) => {
      const step = Number(e?.detail?.step);
      if (Number.isFinite(step) && step >= 1 && step <= 5) setWizardStep(step);
    };
    window.addEventListener('aq:analysis:set', onSet);
    window.addEventListener('aq:analysis:quantum', onQuantum);
    window.addEventListener('aq:analysis:generate', onGenerate);
    window.addEventListener('aq:analysis:download', onDownload);
    window.addEventListener('aq:analysis:downloadPdf', onDownloadPdf);
    window.addEventListener('aq:analysis:share', onShare);
    window.addEventListener('aq:analysis:reset', onReset);
    window.addEventListener('aq:wizard:next', onWizardNext);
    window.addEventListener('aq:wizard:back', onWizardBack);
    window.addEventListener('aq:wizard:goto', onWizardGoto);
    return () => {
      window.removeEventListener('aq:analysis:set', onSet);
      window.removeEventListener('aq:analysis:quantum', onQuantum);
      window.removeEventListener('aq:analysis:generate', onGenerate);
      window.removeEventListener('aq:analysis:download', onDownload);
      window.removeEventListener('aq:analysis:downloadPdf', onDownloadPdf);
      window.removeEventListener('aq:analysis:share', onShare);
      window.removeEventListener('aq:analysis:reset', onReset);
      window.removeEventListener('aq:wizard:next', onWizardNext);
      window.removeEventListener('aq:wizard:back', onWizardBack);
      window.removeEventListener('aq:wizard:goto', onWizardGoto);
    };
  }, []);

  // Broadcasts the live wizard state (category/depth/quantum/step/open) on
  // the same aq:context event DashboardPage uses for page/category -- the
  // voice engine merges these into one context object (see
  // GlobalVoiceAssistant.jsx) so context-dependent commands like "Derin
  // yap" or "Sonraki" know what's currently on screen without needing the
  // category repeated.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('aq:context', {
      detail: {
        page: 'dashboard-analysis',
        category,
        depth,
        quantum: quantumMode,
        wizardStep,
        wizardOpen: !result && !scenarioResult,
        // Lets context-aware voice commands (download/share/reset) keep
        // working once a result is on screen, when wizardOpen has already
        // flipped false -- see voiceAssistantEngine.js's resolveLocalIntent.
        hasResult: !!result,
      },
    }));
  }, [category, depth, quantumMode, wizardStep, result, scenarioResult]);

  // A freshly picked category starts its wizard back at step 1.
  useEffect(() => { setWizardStep(1); }, [category]);

  // Cyber intelligence has one canonical route and one component instance.
  // If an older caller still supplies the legacy inline category, hand it
  // back to DashboardPage's route-aware selector instead of rendering a
  // second copy of the BCI interface here.
  useEffect(() => {
    if (category === 'siber') onCategoryChange?.('siber');
    if (category === 'sfre') onCategoryChange?.('sfre');
  }, [category, onCategoryChange]);

  const cat = CATEGORIES.find(c => c.id === category);
  const isConsult = category === 'danisma';
  const isFraudCategory = category === 'bddk' || category === 'btk';
  const categoryLabel = cat ? t(cat.nameKey) : '';
  // Informational only -- the server's own classifyData() re-derives and
  // enforces the real floor from `category` on every write/upload; this
  // just lets the client tell an attachment upload which classification
  // it's about to belong to (see FileAttach's dataClassification prop and
  // lib/fileScan.js's fail-closed policy) instead of it defaulting to
  // INTERNAL because the request never said otherwise.
  const dataClassification = classifyCategory(category);
  const titlePlaceholder = reportTitleExamples[lang]?.[category] || t('reportTitlePh');

  const handleAIFile = (file) => {
    if (!file) {
      setRealTransactions(null);
      setRealScenarios(null);
      setRealOptimization(null);
      return;
    }
    if (file.type === 'image') {
      setImageFiles((prev) => [...prev, file]);
      return;
    }
    if (file.type === 'transactions') {
      setRealTransactions({ filename: file.filename, transactions: file.transactions, warnings: file.warnings || [] });
      return;
    }
    if (file.type === 'scenarios') {
      setRealScenarios({ filename: file.filename, scenarios: file.scenarios, warnings: file.warnings || [] });
      return;
    }
    if (file.type === 'optimization') {
      setRealOptimization({ filename: file.filename, items: file.items, budgetPercent: file.budgetPercent, warnings: file.warnings || [] });
      return;
    }
    if (file.type === 'text') {
      setDocumentContexts((prev) => [...prev, { filename: file.filename || 'Belge', text: file.text }]);
      return;
    }
    setDocumentContexts((prev) => [...prev, { filename: file.filename || 'Dosya', text: `[Eklenen dosya: ${file.filename}]\n${window.location.origin}${file.url}` }]);
  };

  const removeImageAt = (idx) => setImageFiles((prev) => prev.filter((_, i) => i !== idx));
  const removeDocAt = (idx) => setDocumentContexts((prev) => prev.filter((_, i) => i !== idx));

  // Server errors are plain Turkish text by default (not routed through
  // i18n) except for a few with a machine-readable `code`, which map to a
  // properly localized message here instead of leaking raw Turkish into a
  // UI the user may have set to another language.
  //
  // AllEnginesUnavailableError's own message (routeAnalysisGeneration's
  // 3 call sites in analysisRouter.js each pass a different specific
  // reason -- "Oturum açılmamış", a provider's own error/detail, or
  // nothing) used to be discarded entirely in favor of the generic
  // localized string, making every local-AI failure mode show identical,
  // undiagnosable text. Appending it (when present and not the class's
  // own generic default) costs nothing for the common cloud-unreachable
  // case and turns every future local-AI report into an actionable one.
  const localizedError = (e) => {
    if (e instanceof AllEnginesUnavailableError || e.code === 'ALL_ENGINES_UNAVAILABLE') {
      const base = t('errAllEnginesUnavailable');
      const detail = e.message && e.message !== 'Hiçbir AI motoru şu anda kullanılamıyor.' ? e.message : null;
      return detail ? `${base} (${detail})` : base;
    }
    return e.code === 'ALL_AI_PROVIDERS_FAILED' ? t('errAllProvidersFailed') : e.message;
  };

  // Routes through the Analysis Router (client/src/services/
  // analysisRouter.js) instead of calling api.generateAnalysis directly:
  // cloud when reachable (unchanged behavior/shape), the new local LLM
  // when offline and a model is loadable, the existing extractive
  // archive-synthesis as the last local fallback, and an honest error if
  // nothing answers (task spec point 4).
  const generate = async () => {
    if (!prompt.trim() || !category) return;
    const myGenerationId = ++generationIdRef.current;
    setLoading(true);
    setError('');
    setResult(null);
    setScenarioResult(null);

    try {
      const aiImageData = imageFiles[0] ? { base64: imageFiles[0].base64, mimetype: imageFiles[0].mimetype } : null;
      const mergedContext = documentContexts.length ? documentContexts.map((d) => d.text).join('\n\n') : null;
      const structuredLocalContext = [
        realTransactions && describeStructuredUpload({ type: 'transactions', ...realTransactions }),
        realScenarios && describeStructuredUpload({ type: 'scenarios', ...realScenarios }),
        realOptimization && describeStructuredUpload({ type: 'optimization', ...realOptimization }),
      ].filter(Boolean).join('\n\n');
      const allLocalContext = [mergedContext, structuredLocalContext].filter(Boolean).join('\n\n');
      const realOptimizationPayload = realOptimization ? { items: realOptimization.items, budgetPercent: realOptimization.budgetPercent } : null;
      const resolvedTitle = title || prompt.slice(0, 80);

      const normalized = await routeAnalysisGeneration({
        isOffline,
        cloudCall: () => api.generateAnalysis(category, resolvedTitle, prompt, quantumMode, mergedContext, aiImageData, realTransactions?.transactions || null, realScenarios?.scenarios || null, realOptimizationPayload, lang, priority, depth, dataClassification),
        nativeAIQuery: isNativeApp ? nativeAI.query : undefined,
        generateRequest: { category, title: resolvedTitle, prompt, attachmentContext: allLocalContext, priority, depth, quantumRequested: quantumMode, lang },
      });
      if (generationIdRef.current !== myGenerationId) return; // superseded by a newer request

      // Cloud responses keep their full original shape (quantum/fraud/
      // optimizer sections, docx/pdf, ...) via `raw` spread first so
      // nothing downstream (downloadDocx, ResultSourceBadge, ...)
      // regresses; `engine`/`providerLabel` are added on top for the new
      // indicator, and local engines simply don't have the cloud-only
      // extras (docx/pdf buttons already guard on `res?.docxBase64`).
      const localResult = normalized.engine === ENGINE.LOCAL_LLM ? normalized.raw?.result : null;
      setResult({
        ...(normalized.engine === ENGINE.CLOUD ? normalized.raw : {}),
        title: normalized.title,
        content: normalized.content,
        engine: normalized.engine,
        providerLabel: normalized.providerLabel,
        sources: normalized.sources,
        ...(localResult?.quantumRequested ? { quantumWarning: 'Çevrimdışı analiz yerel modelle üretildi; kuantum devresi çalıştırılmadı ve kuantum doğrulaması yapılmadı.' } : {}),
      });

      // Cloud-generated reports are persisted server-side by api.generateAnalysis
      // itself and reach this device's local History via the next sync --
      // a local-LLM report is genuinely new content that only ever existed
      // in this one response, with no server round-trip to persist it, so
      // without this call it would render once and then be gone the moment
      // the wizard resets ("geçmiş bölümüne kaydetmiyor"). Local-data
      // (archive-synthesis) results are deliberately NOT saved here -- they
      // already just resurface existing History rows, so re-saving them
      // would create a duplicate.
      if (normalized.engine === ENGINE.LOCAL_LLM && nativeAnalyses) {
        nativeAnalyses.create({ category, title: normalized.title, content: normalized.content, aiProvider: normalized.providerLabel }).catch(() => {});
      }
    } catch (e) {
      if (generationIdRef.current !== myGenerationId) return; // superseded by a newer request
      setError(localizedError(e));
    } finally {
      if (generationIdRef.current === myGenerationId) setLoading(false);
    }
  };

  const deepDiveScenario = async (scenario) => {
    setLoadingScenario(scenario.id);
    setScenarioResult(null);
    try {
      const r = await api.scenarioDeepDive(category, scenario.id, scenario.title, lang);
      setScenarioResult({ ...r, scenarioLabel: scenario.title });
    } catch (e) {
      setError('Senaryo analizi basarisiz: ' + localizedError(e));
    } finally {
      setLoadingScenario(null);
    }
  };

  // Local engines (local-llm, local-data) never have docxBase64/pdfBase64 --
  // those are only produced by the cloud's server-side docx/pdf export step
  // (server/src/services/docx.js / pdf.js), which an offline device never
  // talks to. Silently no-op'ing on a missing field (the previous behavior)
  // left the download/share buttons looking broken with zero feedback.
  // localExport.js builds a real, openable docx/pdf client-side from the
  // same res.title/res.content every local result already has.
  const canFetchServerArtifact = (res) => res?.analysisId && res?.engine !== ENGINE.LOCAL_LLM && res?.engine !== ENGINE.LOCAL_DATA;
  const fetchServerDocxBlob = async (analysisId) => (await api.historyDownloadBlob(analysisId)).blob;
  const fetchServerPdfBlob = async (analysisId) => (await api.historyDownloadPdfBlob(analysisId)).blob;

  const downloadDocx = async (res = result) => {
    const blob = res?.docxBase64
      ? base64ToBlob(res.docxBase64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      : canFetchServerArtifact(res)
        ? await fetchServerDocxBlob(res.analysisId)
        : await buildLocalDocxBlob(res || {});
    await downloadBlob(blob, `BQI_${category}_${Date.now()}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  };

  const downloadPdf = async (res = result) => {
    const blob = res?.pdfBase64
      ? base64ToBlob(res.pdfBase64, 'application/pdf')
      : canFetchServerArtifact(res)
        ? await fetchServerPdfBlob(res.analysisId)
        : buildLocalPdfBlob(res || {});
    await downloadBlob(blob, `BQI_${category}_${Date.now()}.pdf`, 'application/pdf');
  };

  const shareReport = async (res = result) => {
    const blob = res?.pdfBase64
      ? base64ToBlob(res.pdfBase64, 'application/pdf')
      : canFetchServerArtifact(res)
        ? await fetchServerPdfBlob(res.analysisId)
        : buildLocalPdfBlob(res || {});
    shareOrDownloadBlob(blob, `BQI_${category}_${Date.now()}.pdf`, 'application/pdf', res.title || 'BQI Raporu');
  };

  const reset = () => {
    setResult(null);
    setScenarioResult(null);
    setPrompt('');
    setTitle('');
    setError('');
    setDocumentContexts([]);
    setImageFiles([]);
    setRealTransactions(null);
    setRealScenarios(null);
    setRealOptimization(null);
    setWizardStep(1);
  };

  generateRef.current = generate;
  downloadDocxRef.current = downloadDocx;
  downloadPdfRef.current = downloadPdf;
  shareRef.current = shareReport;
  resetRef.current = reset;

  if (!category) return <CategoryPicker onSelect={onCategoryChange} />;
  if (isConsult) return <div className="max-w-4xl mx-auto"><ConsultChat /></div>;
  if (category === 'siber' || category === 'sfre') return null;

  const sourceCount = documentContexts.length + imageFiles.length + (realTransactions ? 1 : 0) + (realScenarios ? 1 : 0) + (realOptimization ? 1 : 0);
  const hasData = sourceCount > 0;
  const hasPrompt = prompt.trim().length > 0;

  return (
    <div className="max-w-[1500px] mx-auto">
      {!result && !scenarioResult && (
        <AnalysisWizard
          t={t}
          lang={lang}
          open
          onClose={() => onCategoryChange(null)}
          category={category} setCategory={onCategoryChange} categoryLabel={categoryLabel} isFraudCategory={isFraudCategory}
          title={title} setTitle={setTitle} titlePlaceholder={titlePlaceholder}
          prompt={prompt} setPrompt={setPrompt}
          priority={priority} setPriority={setPriority}
          depth={depth} setDepth={setDepth}
          quantumMode={quantumMode} setQuantumMode={setQuantumMode}
          step={wizardStep} setStep={setWizardStep}
          documentContexts={documentContexts} imageFiles={imageFiles}
          realTransactions={realTransactions} realScenarios={realScenarios} realOptimization={realOptimization}
          removeImageAt={removeImageAt} removeDocAt={removeDocAt}
          setRealTransactions={setRealTransactions} setRealScenarios={setRealScenarios} setRealOptimization={setRealOptimization}
          handleAIFile={handleAIFile}
          error={error} loading={loading} hasPrompt={hasPrompt} generate={generate}
        />
      )}
      <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="mb-3 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-cyan-400/10 border border-cyan-400/30 flex items-center justify-center">
            {cat && <cat.icon className="w-5 h-5 text-cyan-300" />}
          </div>
          <div>
            <div className="text-[12px] tracking-[0.24em] text-cyan-300/60">BQI / ANALİZ MERKEZİ</div>
            <h2 className="text-sm sm:text-lg font-display tracking-[0.14em] text-cyan-100 uppercase">{categoryLabel}</h2>
          </div>
        </div>
        <EngineBadges quantumMode={quantumMode} hasData={hasData} />
      </motion.div>

      <AnalysisWorkflow hasPrompt={hasPrompt} hasData={hasData} quantumMode={quantumMode} hasResult={!!result} loading={loading} />

      {!scenarioResult && (
        <div className={`grid grid-cols-1 gap-3 items-start ${result ? 'lg:grid-cols-[300px_minmax(0,1fr)_280px]' : 'lg:grid-cols-[minmax(0,1fr)_280px]'}`}>
          {result && (
            <TaskDefinitionPanel
              t={t}
              title={title} setTitle={setTitle}
              categoryLabel={categoryLabel}
              titlePlaceholder={titlePlaceholder}
              prompt={prompt} setPrompt={setPrompt}
              documentContexts={documentContexts} imageFiles={imageFiles}
              realTransactions={realTransactions} realScenarios={realScenarios} realOptimization={realOptimization}
              removeImageAt={removeImageAt} removeDocAt={removeDocAt}
              setRealTransactions={setRealTransactions} setRealScenarios={setRealScenarios} setRealOptimization={setRealOptimization}
              handleAIFile={handleAIFile}
              dataClassification={dataClassification}
              quantumMode={quantumMode} setQuantumMode={setQuantumMode}
              isFraudCategory={isFraudCategory}
              error={error}
              loading={loading}
              hasPrompt={hasPrompt}
              generate={generate}
              locked={!!result}
            />
          )}

          <section className="min-w-0 space-y-3">
            {!result && !loading && (
              <div className={`${PANEL} p-8 flex flex-col items-center justify-center text-center min-h-[260px]`}>
                <Sparkles className="w-8 h-8 text-cyan-400/40 mb-3" />
                <div className="text-[14px] tracking-[0.14em] text-white/40">ANALİZ AKIŞI BEKLEMEDE</div>
                <p className="text-[13px] text-white/25 mt-1 max-w-sm">Görevi tanımlayıp raporu üret dediğinizde AI analizi, kuantum devresi ve karar izi burada canlı olarak akacak.</p>
              </div>
            )}
            {loading && (
              <div className={`${PANEL} p-8 flex flex-col items-center justify-center text-center min-h-[260px]`}>
                <Loader2 className="w-8 h-8 text-cyan-300 animate-spin mb-3" />
                <div className="text-[14px] tracking-[0.14em] text-cyan-200">{quantumMode ? t('analyzingQuantum') : t('analyzing')}</div>
                <p className="text-[13px] text-white/25 mt-1">AI çıkarımı ve {quantumMode ? 'kuantum devresi ' : ''}çalıştırılıyor…</p>
              </div>
            )}

            {result && !result.quantumMode && result.quantumWarning === undefined && null}

            {result && (
              <ResultPanel
                t={t} result={result}
                downloadDocx={downloadDocx} downloadPdf={downloadPdf} shareReport={shareReport} reset={reset}
                deepDiveScenario={deepDiveScenario} loadingScenario={loadingScenario}
              />
            )}
          </section>

          <aside className="space-y-3">
            <DecisionTraceLive hasPrompt={hasPrompt} quantumMode={quantumMode} loading={loading} result={result} sourceCount={sourceCount} category={category} />
            {result && <ResultProvenance result={result} />}
            {result && <DecisionPipelinePanel result={result} />}
          </aside>
        </div>
      )}

      {scenarioResult && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
          <div className="flex items-center gap-3 bg-[#031326]/80 border border-cyan-400/20 rounded-lg p-3">
            <button onClick={() => setScenarioResult(null)} className="text-cyan-300/70 hover:text-cyan-200 flex items-center gap-1 text-xs"><ArrowLeft className="w-4 h-4" /> {t('backToMain')}</button>
            <div className="flex-1 text-center"><span className="text-cyan-100 font-display text-sm tracking-widest">{t('altScenario')}: {scenarioResult.scenarioLabel}</span></div>
            <button onClick={() => downloadDocx(scenarioResult)} className="btn-gold px-3 py-1.5 rounded text-xs tracking-widest flex items-center gap-2"><Download className="w-3 h-3" /> .DOCX</button>
            <button onClick={() => downloadPdf(scenarioResult)} className="btn-gold px-3 py-1.5 rounded text-xs tracking-widest flex items-center gap-2"><FileDown className="w-3 h-3" /> .PDF</button>
            <button onClick={() => shareReport(scenarioResult)} className="border border-cyan-400/30 text-cyan-200 px-3 py-1.5 rounded text-xs tracking-widest hover:bg-cyan-400/10 flex items-center gap-2"><Share2 className="w-3 h-3" /> {t('share')}</button>
          </div>
          <div className="bg-[#031326]/80 border border-cyan-400/25 rounded-lg p-8 report-content max-h-[70vh] overflow-auto text-white/80"><ReactMarkdown remarkPlugins={[remarkGfm]}>{scenarioResult.content}</ReactMarkdown></div>
        </motion.div>
      )}
    </div>
  );
}

function EngineBadges({ quantumMode, hasData }) {
  const badges = [
    ['AI REASONING', BrainCircuit, true, 'READY'],
    ['REAL DATA', Database, hasData, hasData ? 'READY' : 'AUTO'],
    ['CLASSICAL', Gauge, true, 'READY'],
    ['QISKIT AER', Atom, quantumMode, quantumMode ? 'ENABLED' : 'OPTIONAL'],
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map(([label, Icon, on, state]) => (
        <div key={label} className="rounded border border-cyan-400/15 bg-[#031326]/80 px-2.5 py-2 flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 ${on ? 'text-cyan-300/80' : 'text-white/25'}`} />
          <div>
            <div className="text-[11px] tracking-wider text-white/55">{label}</div>
            <div className={`text-[11px] tracking-wider ${on ? 'text-emerald-300/70' : 'text-white/25'}`}>{on ? '● ' : '○ '}{state}</div>
          </div>
        </div>
      ))}
      <div className="rounded border border-amber-300/15 bg-[#031326]/80 px-2.5 py-2 flex items-center gap-2">
        <ShieldCheck className="w-3.5 h-3.5 text-amber-300/70" />
        <div><div className="text-[11px] tracking-wider text-white/55">IBM HARDWARE</div><div className="text-[11px] tracking-wider text-amber-300/70">○ VERIFY ON DEMAND</div></div>
      </div>
    </div>
  );
}

function TaskDefinitionPanel(props) {
  const {
    t, title, setTitle, categoryLabel, titlePlaceholder, prompt, setPrompt,
    documentContexts, imageFiles, realTransactions, realScenarios, realOptimization,
    removeImageAt, removeDocAt, setRealTransactions, setRealScenarios, setRealOptimization,
    handleAIFile, dataClassification, quantumMode, setQuantumMode, isFraudCategory, error, loading, hasPrompt, generate, locked,
  } = props;

  const sources = [
    ...documentContexts.map((d, i) => ({ key: `doc-${i}`, name: d.filename, icon: FileText, onRemove: () => removeDocAt(i) })),
    ...imageFiles.map((img, i) => ({ key: `img-${i}`, name: img.filename, icon: ImageIcon, onRemove: () => removeImageAt(i) })),
    ...(realTransactions ? [{ key: 'tx', name: `${realTransactions.filename} · ${realTransactions.transactions.length} işlem`, icon: FileText, onRemove: () => setRealTransactions(null) }] : []),
    ...(realScenarios ? [{ key: 'sc', name: `${realScenarios.filename} · ${realScenarios.scenarios.length} senaryo`, icon: FileText, onRemove: () => setRealScenarios(null) }] : []),
    ...(realOptimization ? [{ key: 'opt', name: `${realOptimization.filename} · ${realOptimization.items.length} kalem`, icon: FileText, onRemove: () => setRealOptimization(null) }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className={PANEL}>
        <div className="h-9 px-3 flex items-center border-b border-cyan-400/10">
          <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Görev Tanımı</span>
        </div>
        <div className="p-3 space-y-3">
          <div>
            <label className="block text-[12px] text-cyan-300/50 tracking-widest uppercase mb-1.5">{t('reportTitle')} ({categoryLabel})</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} disabled={locked} placeholder={titlePlaceholder} className="w-full bg-black/25 border border-cyan-400/20 rounded px-2.5 py-2 text-[14px] text-cyan-100 focus:border-cyan-300 focus:outline-none disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-[12px] text-cyan-300/50 tracking-widest uppercase mb-1.5">{t('analysisTopic')}</label>
            <div className="relative">
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} disabled={locked} placeholder={documentContexts.length > 0 ? 'Yuklenen belgelere dayanarak analiz uret...' : t('topicPh')} rows={5} className="w-full bg-black/25 border border-cyan-400/20 rounded p-2.5 pr-10 text-[14px] text-cyan-100 focus:border-cyan-300 focus:outline-none disabled:opacity-50" />
              <div className="absolute bottom-2 right-2"><VoiceButton mode="input" onTranscript={text => setPrompt(prev => prev ? prev + ' ' + text : text)} size="sm" /></div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-cyan-300/40 tracking-widest uppercase">Kaynak Dosya</span>
            <FileAttach onAIFile={handleAIFile} dataClassification={dataClassification} />
          </div>
          {quantumMode && (
            <p className="text-[12px] text-white/35 leading-relaxed">
              {isFraudCategory
                ? 'Gerçek işlem dökümü (CSV/Excel — "Tutar" ve "Saat"/"Tarih" sütunları gerekli) yükleyebilirsiniz; yüklenirse kuantum motoru yapay örnek kayıtlar yerine bu gerçek kayıtları puanlar.'
                : 'Gerçek senaryo verisi ("Senaryo"/"Olasılık" sütunları) veya kaynak tahsisi tablosu ("Kalem"/"Değer"/"Maliyet" sütunları) yükleyebilirsiniz; yüklenirse kuantum motoru YZ tahmini yerine bu gerçek verileri kullanır.'}
            </p>
          )}
          {error && <div className="text-red-300 text-[13px] bg-red-500/10 border border-red-500/30 rounded p-2">⚠ {error}</div>}
        </div>
      </div>

      <div className={PANEL}>
        <div className="h-9 px-3 flex items-center border-b border-cyan-400/10">
          <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Veri Kaynakları</span>
          <span className="ml-auto text-[12px] text-cyan-400/60">{sources.length}</span>
        </div>
        <div className="p-3 space-y-1.5">
          {sources.length === 0 && <div className="text-[13px] text-white/25">Henüz kaynak eklenmedi</div>}
          {sources.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[13px] text-white/60">
              <s.icon className="w-3 h-3 text-cyan-400/50 flex-shrink-0" />
              <span className="truncate flex-1">{s.name}</span>
              <button type="button" onClick={s.onRemove} disabled={locked} className="text-red-300/70 hover:text-red-300 disabled:opacity-30">×</button>
            </div>
          ))}
        </div>
      </div>

      <div className={PANEL}>
        <div className="h-9 px-3 flex items-center border-b border-cyan-400/10">
          <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Analiz Motorları</span>
        </div>
        <div className="p-3 space-y-2">
          <EngineRow label="AI Reasoning (LLM)" on always />
          <EngineRow label="Classical Baseline" on always />
          <div onClick={() => !locked && setQuantumMode(!quantumMode)} className={`flex items-start gap-2.5 p-2.5 rounded border cursor-pointer transition select-none ${quantumMode ? 'bg-cyan-400/10 border-cyan-300/50' : 'bg-black/20 border-cyan-400/15 hover:border-cyan-400/35'} ${locked ? 'pointer-events-none opacity-60' : ''}`}>
            <div className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition ${quantumMode ? 'bg-cyan-300 border-cyan-300' : 'border-cyan-400/40'}`}>{quantumMode && <Check className="w-2.5 h-2.5 text-[#031326]" />}</div>
            <div>
              <div className="flex items-center gap-1.5 mb-0.5"><Atom className="w-3.5 h-3.5 text-cyan-300" /><span className="text-cyan-100 font-display tracking-widest text-[14px]">{t('quantumMode')}</span></div>
              <p className="text-[12px] text-white/40 leading-relaxed">{t(isFraudCategory ? 'quantumDescFraud' : 'quantumDesc')}</p>
            </div>
          </div>
          <EngineRow label="IBM Quantum Verification" on={quantumMode} pending />
        </div>
        <div className="p-3 pt-0">
          <button onClick={generate} disabled={loading || !hasPrompt || locked} className="w-full btn-gold py-2.5 rounded font-display tracking-widest text-[14px] disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" />{quantumMode ? t('analyzingQuantum') : t('analyzing')}</> : <>{quantumMode ? <Atom className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}{quantumMode ? t('generateQuantum') : t('generateAnalysis')}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function EngineRow({ label, on, always = false, pending = false }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${on ? 'bg-cyan-300 border-cyan-300' : 'border-white/15'}`}>{on && <Check className="w-2.5 h-2.5 text-[#031326]" />}</div>
      <span className="text-white/55">{label}</span>
      <span className={`ml-auto text-[11px] ${always ? 'text-emerald-300/70' : on ? (pending ? 'text-amber-300/70' : 'text-emerald-300/70') : 'text-white/25'}`}>
        {always ? 'HAZIR' : on ? (pending ? 'TALEP ÜZERİNE' : 'ETKİN') : 'PASİF'}
      </span>
    </div>
  );
}

function ResultPanel({ t, result, downloadDocx, downloadPdf, shareReport, reset, deepDiveScenario, loadingScenario }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
      {result.engine === ENGINE.LOCAL_LLM && (
        <div className="bg-emerald-500/10 border border-emerald-400/30 rounded-lg p-3 text-xs text-emerald-300">{t('qLocalLlmGenerated')}</div>
      )}
      {result.engine === ENGINE.LOCAL_DATA && (
        <div className="bg-amber-500/10 border border-amber-400/30 rounded-lg p-3 text-xs text-amber-300">{t('qLocalDataGenerated')}</div>
      )}
      {result.quantumWarning && (
        <div className="bg-amber-500/10 border border-amber-400/40 rounded-lg p-3 text-xs text-amber-300 flex items-start gap-2">
          <span>⚠️</span><span>{result.quantumWarning}</span>
        </div>
      )}
      <div className={`${PANEL} flex items-center justify-between p-3 flex-wrap gap-2`}>
        <div className="text-xs text-cyan-300/70 flex items-center gap-2">
          <EngineBadge engine={result.engine} size="md" />
          {result.quantumMode && <Atom className="w-3 h-3 text-cyan-300" />}
          {result.quantum && (
            <>
              <span className="font-mono text-xs text-cyan-300/80" title="Qiskit Aer yerel kuantum devre simülatörü">
                {result.quantum.backend} · {result.quantum.qubits} kübit · {result.quantum.shots} ölçüm
              </span>
              <ResultSourceBadge source={result.quantum.resultSource} />
            </>
          )}
          {result.fraud && (
            <>
              <span className="font-mono text-xs text-cyan-300/80" title="Kuantum çekirdek (kernel) anomali tespiti">
                {result.fraud.backend} · {result.fraud.qubits} kübit · {result.fraud.flaggedCount}/{result.fraud.transactionCount} işaretlendi
              </span>
              <ResultSourceBadge source={result.fraud.resultSource} />
            </>
          )}
          {result.optimizer && (
            <>
              <span className="font-mono text-xs text-cyan-300/80" title="QAOA kaynak tahsisi optimizasyonu">
                {result.optimizer.backend} · {result.optimizer.qubits} kübit · %{result.optimizer.totalCost}/%{result.optimizer.budgetPercent} bütçe kullanıldı
              </span>
              <ResultSourceBadge source={result.optimizer.resultSource} />
            </>
          )}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <VoiceButton mode="output" text={result.content} size="sm" />
          <button onClick={() => downloadDocx(result)} className="btn-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2"><Download className="w-4 h-4" /> {t('downloadDocx')}</button>
          <button onClick={() => downloadPdf(result)} className="btn-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2"><FileDown className="w-4 h-4" /> {t('downloadPdf')}</button>
          <button onClick={() => shareReport(result)} className="border border-cyan-400/30 text-cyan-200 px-4 py-2 rounded text-xs tracking-widest hover:bg-cyan-400/10 flex items-center gap-2"><Share2 className="w-4 h-4" /> {t('share')}</button>
          <button onClick={reset} className="border border-cyan-400/30 text-cyan-200 px-4 py-2 rounded text-xs tracking-widest hover:bg-cyan-400/10">{t('newAnalysisBtn')}</button>
        </div>
      </div>

      {result.quantum && <QuantumCircuitPanel quantum={result.quantum} />}

      {result.quantumMode && result.scenarios && result.scenarios.length > 0 && <ScenarioComparisonTable scenarios={result.scenarios} />}
      {result.quantumMode && result.scenarios && result.scenarios.length > 0 && <ScenarioPanel scenarios={result.scenarios} onDeepDive={deepDiveScenario} loadingScenario={loadingScenario} t={t} />}
      {result.quantumMode && result.scenarios?.some(s => s.quantumProbability !== undefined) && <ScenarioComparisonChart scenarios={result.scenarios} />}

      {result.fraud?.secondaryReview && (
        <div className={`${PANEL} p-4 flex flex-col gap-3`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h4 className="font-display text-cyan-100 tracking-widest text-xs uppercase">İkincil Onay Katmanı</h4>
              <p className="text-xs text-white/35 mt-0.5">Birincil işaretlerin hangilerinin uygulama içinde doğrudan onaylandığını gösterir.</p>
            </div>
            <div className="text-xs font-mono text-cyan-300/80">
              {result.fraud.secondaryReview.confirmedCount}/{result.fraud.secondaryReview.total} onaylandı
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div className="rounded border border-emerald-500/20 bg-emerald-950/20 px-3 py-2">
              <div className="text-emerald-300 font-mono">Onaylanan</div>
              <div className="text-cyan-100 font-mono text-base">{result.fraud.secondaryReview.confirmedCount}</div>
            </div>
            <div className="rounded border border-amber-500/20 bg-amber-950/20 px-3 py-2">
              <div className="text-amber-300 font-mono">Manuel inceleme</div>
              <div className="text-cyan-100 font-mono text-base">{result.fraud.secondaryReview.reviewCount}</div>
            </div>
            <div className="rounded border border-cyan-500/20 bg-cyan-950/20 px-3 py-2">
              <div className="text-cyan-300 font-mono">Kural sayısı</div>
              <div className="text-cyan-100 font-mono text-base">{Object.keys(result.fraud.secondaryReview.rules || {}).length}</div>
            </div>
          </div>
        </div>
      )}

      {result.fraud?.transactions?.length > 0 && <FraudRiskChart transactions={result.fraud.transactions} confirmedIds={result.fraud.secondaryReview?.confirmedIds || []} />}
      {result.optimizer?.items?.length > 0 && <OptimizerChart items={result.optimizer.items} />}

      <div className={`${PANEL} p-8 report-content max-h-[70vh] overflow-auto text-white/80`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown></div>
    </motion.div>
  );
}

// Real circuit stats (qubits/depth/shots/batches/backend) come straight from
// the Qiskit Aer run -- only the gate-grid graphic below is a stylized,
// representative rendering (the server doesn't ship a gate-by-gate diagram
// to the client), sized off the real qubit/depth counts.
function QuantumCircuitPanel({ quantum }) {
  const qubits = quantum.qubits || 0;
  const depth = quantum.circuitDepth || 0;
  const rows = Math.max(1, Math.min(qubits, 8));
  const cols = Math.max(1, Math.min(depth, 12));
  const gateAt = (r, c) => (r + c * 2) % 5 === 0;
  const gateLabel = (r, c) => ['H', 'RY', 'RZ', 'CRX'][(r + c) % 4];
  return (
    <div className={PANEL}>
      <div className="h-9 px-3 flex items-center gap-2 border-b border-cyan-400/10">
        <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Qiskit Devre Önizlemesi</span>
        <ResultSourceBadge source={quantum.resultSource} />
        <span className="ml-auto text-[12px] text-white/30">{qubits} qubit · {depth} derinlik{quantum.shots ? ` · ${quantum.shots} shots` : ''}</span>
      </div>
      <div className="p-3 overflow-x-auto">
        <div className="min-w-[420px]">
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="flex items-center gap-1.5 mb-1.5">
              <span className="w-6 text-[11px] text-white/25 font-mono">q{r}</span>
              <div className="flex-1 flex items-center gap-1.5 border-t border-cyan-400/15 pt-1.5">
                {Array.from({ length: cols }).map((_, c) => gateAt(r, c) ? (
                  <span key={c} className="px-1.5 py-1 rounded border border-cyan-400/40 bg-cyan-400/10 text-cyan-200 text-[11px] font-mono">{gateLabel(r, c)}</span>
                ) : <span key={c} className="w-4 h-px bg-cyan-400/10" />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 border-t border-cyan-400/10 text-center">
        {[['Qubit', qubits], ['Derinlik', depth], ['Shots', quantum.shots ?? '—'], ['Batch', quantum.batches ?? '—'], ['Kaynak', quantum.dataSource === 'real' ? 'Gerçek' : 'YZ tahmini']].map(([l, v]) => (
          <div key={l} className="p-2 border-r border-cyan-400/10 last:border-r-0">
            <div className="text-[14px] text-cyan-200 font-mono">{v}</div>
            <div className="text-[11px] text-white/30">{l}</div>
          </div>
        ))}
      </div>
      {quantum.classicalBenchmark && (
        <div className="px-3 py-2 border-t border-cyan-400/10 text-[12px] text-white/40">
          {quantum.classicalBenchmark.topScenarioAgrees
            ? '✅ Klasik (YZ) taban çizgisiyle aynı senaryo en olası çıktı'
            : '⚠️ Kuantum devresi en olası senaryoyu klasik tahminden farklı belirledi'}
          {' · ortalama sapma %'}{quantum.classicalBenchmark.meanAbsoluteDeviationPercent}
        </div>
      )}
    </div>
  );
}

function ScenarioComparisonTable({ scenarios }) {
  const hasHardware = scenarios.some((s) => s.hardwareProbability !== undefined);
  return (
    <div className={PANEL}>
      <div className="h-9 px-3 flex items-center border-b border-cyan-400/10">
        <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Senaryo Sonuçları</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-white/35 border-b border-cyan-400/10">
              <th className="text-left font-normal px-3 py-2">Senaryo</th>
              <th className="text-right font-normal px-3 py-2">AI (LLM)</th>
              <th className="text-right font-normal px-3 py-2">Qiskit Aer (Sim)</th>
              {hasHardware && <th className="text-right font-normal px-3 py-2">IBM Quantum (Real)</th>}
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.id} className="border-b border-white/5 last:border-b-0">
                <td className="px-3 py-1.5 text-white/70 truncate max-w-[220px]">{s.title}</td>
                <td className="px-3 py-1.5 text-right font-mono text-cyan-300/80">{s.llmEstimate !== undefined ? `%${s.llmEstimate}` : '—'}</td>
                <td className="px-3 py-1.5 text-right font-mono text-cyan-200">{s.quantumProbability !== undefined ? `%${s.quantumProbability}` : '—'}</td>
                {hasHardware && <td className="px-3 py-1.5 text-right font-mono text-amber-300/80">{s.hardwareProbability !== undefined ? `%${s.hardwareProbability}` : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* BQI-006: this table's quantum columns are a quantum-transformed
          scenario distribution (the AI's estimate re-expressed via a
          quantum circuit measurement), not an independent real-world
          measurement or a validated event-occurrence probability. */}
      <p className="px-3 pb-2 text-[11px] text-white/30 leading-relaxed">
        Kuantum sütunları (Qiskit Aer / IBM Quantum), YZ tahmininin bir kuantum devresine yüklenip ölçüm yoluyla yeniden ifade edilmesiyle elde edilen kuantum dönüşümlü bir dağılımdır — bağımsız bir gerçek-dünya ölçümü veya doğrulanmış olay gerçekleşme olasılığı değildir.
      </p>
    </div>
  );
}

function DecisionTraceLive({ hasPrompt, quantumMode, loading, result, sourceCount, category }) {
  const now = () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const steps = [
    { label: 'Görev Tanımlandı', done: hasPrompt, detail: hasPrompt ? `Kategori: ${category}` : 'Bekleniyor' },
    { label: 'Veri Doğrulama', done: hasPrompt, detail: sourceCount ? `${sourceCount} kaynak eklendi` : 'Kaynak eklenmedi (opsiyonel)' },
    { label: 'AI Analizi', done: !!result, current: loading, detail: result ? 'Tamamlandı' : loading ? 'Çalışıyor…' : 'Bekleniyor' },
    { label: 'Devre Üretimi', done: !!result?.quantum, current: loading && quantumMode, detail: result?.quantum ? `${result.quantum.qubits} qubit devre çalıştırıldı` : quantumMode ? 'Bekleniyor' : 'Devre dışı' },
    { label: 'Karar Birleştirme', done: !!result, detail: result ? 'Kaynaklar tek rapora birleştirildi' : 'Bekleniyor' },
    { label: 'Rapor Oluşturma', done: !!result, detail: result ? 'DOCX / PDF hazır' : 'Bekleniyor' },
  ];
  return (
    <div className={PANEL}>
      <div className="h-9 px-3 flex items-center border-b border-cyan-400/10">
        <span className="text-[13px] text-cyan-100 tracking-[0.15em] font-semibold uppercase">Decision Trace</span>
        <span className="ml-auto text-[11px] text-cyan-400/60">CANLI</span>
      </div>
      <div className="p-3 space-y-3">
        {steps.map((s, i) => (
          <div key={s.label} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${s.done ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300' : s.current ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-200 animate-pulse' : 'border-white/10 text-white/25'}`}>
                {s.done ? <Check className="w-3 h-3" /> : <Clock className="w-2.5 h-2.5" />}
              </span>
              {i < steps.length - 1 && <span className="w-px flex-1 bg-white/10 mt-1" />}
            </div>
            <div className="pb-2.5 min-w-0">
              <div className={`text-[12px] tracking-wider font-semibold ${s.done ? 'text-emerald-300/80' : s.current ? 'text-cyan-200' : 'text-white/35'}`}>{s.label}</div>
              <div className="text-[12px] text-white/30 mt-0.5">{s.detail}</div>
              {s.done && <div className="text-[11px] text-white/20 mt-0.5">{now()}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScenarioPanel({ scenarios, onDeepDive, loadingScenario, t }) {
  return (
    <div className={`${PANEL} p-4`}>
      <div className="flex items-center gap-2 mb-1"><Atom className="w-4 h-4 text-cyan-300 animate-pulse" /><h3 className="font-display text-cyan-100 tracking-widest text-xs">{t('quantumMatrix')}</h3></div>
      <p className="text-[12px] text-white/30 mb-3 leading-relaxed">YZ'nin ilk tahmini kuantum genliği olarak devreye yüklenir; burada gösterilen yüzde dünyadaki olayın bağımsız bir kuantum ölçümü <strong>değildir</strong> — bu genliğin belirlenmiş bir karışım (mixer) devresinden geçtikten sonraki ölçüm dağılımıdır. Devre, YZ'nin ön tahminini dönüştürür; onu doğrulayan bağımsız bir gerçek-dünya ölçümü üretmez.</p>
      <div className="space-y-2">
        {scenarios.map((s, i) => (
          <motion.div key={s.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1 }} className={`flex items-center gap-3 p-2.5 rounded border ${i === 0 ? 'border-cyan-300/50 bg-cyan-400/10' : 'border-cyan-400/15 bg-black/20 hover:border-cyan-400/35'}`}>
            <div className="flex-1 min-w-0">
              <span className="text-cyan-100/90 text-xs font-display tracking-wide truncate">{s.title}</span>
              {s.quantumProbability !== undefined && (
                <div className="text-[13px] font-mono text-cyan-300/70 mt-0.5">
                  YZ tahmini %{s.llmEstimate} → kuantum devresi %{s.quantumProbability}
                </div>
              )}
            </div>
            {i !== 0 && <button onClick={() => onDeepDive(s)} disabled={!!loadingScenario} className="flex-shrink-0 btn-gold px-3 py-1.5 rounded text-[14px] tracking-widest flex items-center gap-1 disabled:opacity-50">{loadingScenario === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><BarChart3 className="w-3 h-3" /> {t('analyzeBtn')}</>}</button>}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// Corner bracket scoped to its own (relatively positioned) parent, not the
// viewport -- LoginPageDecor.jsx's <Corner> is `fixed` to the whole screen,
// which only makes sense for a full-page boot screen. This mirrors its
// visual language (the same command-center HUD corner) but stays contained
// inside whatever panel renders it.
function PanelCorner({ pos }) {
  const cls = {
    tl: 'top-0 left-0 border-t-2 border-l-2',
    tr: 'top-0 right-0 border-t-2 border-r-2',
    bl: 'bottom-0 left-0 border-b-2 border-l-2',
    br: 'bottom-0 right-0 border-b-2 border-r-2',
  }[pos];
  return <span className={`absolute w-5 h-5 border-cyan-300/40 pointer-events-none ${cls}`} />;
}

function CategoryPicker({ onSelect }) {
  const { t } = useLang();
  return (
    <div className="max-w-4xl mx-auto relative rounded-xl border border-cyan-400/15 bg-[#031326]/50 p-6 sm:p-8 overflow-hidden">
      {/* Command-center HUD backdrop: faint scanning grid + center glow, contained to this panel (not viewport-fixed like the login screen's). */}
      <div className="absolute inset-0 pointer-events-none opacity-60" style={{
        backgroundImage: 'linear-gradient(rgba(0,212,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.05) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }} />
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 70% 60% at 50% 0%, rgba(0,150,220,0.10) 0%, transparent 70%)',
      }} />
      <PanelCorner pos="tl" /><PanelCorner pos="tr" /><PanelCorner pos="bl" /><PanelCorner pos="br" />

      <div className="relative flex items-center justify-center gap-2 mb-1">
        <motion.span className="w-1.5 h-1.5 rounded-full bg-emerald-400"
          animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.4, repeat: Infinity }} />
        <span className="text-[12px] tracking-[0.25em] text-emerald-400/80 font-mono uppercase">Sistem Hazır</span>
      </div>
      <h2 className="relative text-2xl font-display text-cyan-100 tracking-widest text-center mb-6">{t('newAnalysis')}</h2>

      <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-3">
        {CATEGORIES.map((cat, i) => {
          const Icon = cat.icon;
          return (
            <motion.button
              key={cat.id}
              onClick={() => onSelect(cat.id)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.3 }}
              whileHover={{ y: -2 }}
              className="group relative bg-[#031326]/80 border border-cyan-400/15 hover:border-cyan-300/60 rounded-lg p-5 transition-colors flex flex-col items-center gap-3 overflow-hidden"
              style={{ minHeight: 130 }}
            >
              {/* Radar-sweep glow on hover -- same conic-gradient technique as LoginPageDecor's OrbitalLogo scanner. */}
              <span className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" style={{
                background: 'conic-gradient(from 0deg, transparent 70%, rgba(0,212,255,0.12) 100%)',
              }} />
              <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-cyan-400/50 group-hover:bg-emerald-400 transition-colors" />
              <Icon className="relative w-10 h-10 transition-transform group-hover:scale-110" style={{ color: cat.color }} />
              <p className="relative font-display tracking-wider text-xs text-cyan-100 uppercase text-center leading-tight">{t(cat.nameKey)}</p>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
