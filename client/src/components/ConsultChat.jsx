import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Trash2, Loader2, User, Bot, MessageSquare, WifiOff } from 'lucide-react';
import { api } from '../services/api.js';
import VoiceButton from './VoiceButton.jsx';
import FileAttach, { describeStructuredUpload } from './FileAttach.jsx';
import EngineBadge from './EngineBadge.jsx';
import { useLang } from '../services/langContext.jsx';
import { isNativeApp, nativeAI, nativeConnectivity } from '../services/nativeBridge.js';
import { routeConsultChat, AllEnginesUnavailableError } from '../services/analysisRouter.js';
import { ENGINE } from '../services/aiContract.js';
import { isLocalModeForced, subscribeLocalModePreference } from '../services/localModePreference.js';
import { isAppModeOffline, subscribeAppModePreference } from '../services/appModePreference.js';

const STORAGE_KEY = 'aq_consult_history';

// Formats the offline extractive-search engine's structured result
// (see mobile/localAI + desktop/localAI's offlineExtractive.js) as
// markdown, since it answers with report matches/summaries/comparisons,
// not free-text prose the way the cloud assistant or the local LLM do.
// `structured` is analysisRouter's normalizeLocalChat() output's
// `.structured` field ({ type, result }).
function formatLocalAIResult(t, structured) {
  if (!structured) return `_${t('localAiNoResults')}_`;
  const { type, result } = structured;
  if (type === 'find') {
    if (!result?.length) return `_${t('localAiNoResults')}_`;
    return result.map((r) =>
      `**${r.title}** _(${r.category}, ${new Date(r.createdAt).toLocaleDateString()})_\n${r.preview}${r.preview?.length >= 200 ? '…' : ''}`
    ).join('\n\n---\n\n');
  }
  if (type === 'summary') {
    if (!result) return `_${t('localAiNoResults')}_`;
    return `**${result.title}**\n\n${result.summary}`;
  }
  if (type === 'compare') {
    if (!result) return `_${t('localAiNoResults')}_`;
    return `**${result.a.title}** vs **${result.b.title}**\n\n` +
      `Ortak terim sayısı: ${result.commonTermCount} · Benzerlik: %${Math.round(result.similarity * 100)}`;
  }
  return `_${t('localAiNoResults')}_`;
}

export default function ConsultChat() {
  const { t } = useLang();
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiFiles, setAIFiles] = useState([]);
  const [connectivity, setConnectivity] = useState('cloud');
  const [forceLocalMode, setForceLocalModeState] = useState(() => isLocalModeForced());
  const [appModeOffline, setAppModeOffline] = useState(() => isAppModeOffline());
  // App-wide Offline Mode (Settings > Bağlantı) ORs into the same effective
  // offline flag as forceLocalMode/connectivity -- mirrors AnalysisView.jsx.
  const isOffline = forceLocalMode || appModeOffline || (isNativeApp && connectivity === 'local');

  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const handleAIFile = (result) => {
    if (!result) return;
    setAIFiles((prev) => [...prev, result]);
  };

  useEffect(() => {
    try {
      const toSave = messages.slice(-60).map(m => ({ ...m, imageData: undefined }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {}
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (!isNativeApp) return;
    let cancelled = false;
    nativeConnectivity.getState().then((state) => { if (!cancelled) setConnectivity(state); }).catch(() => {});
    const unsubscribe = nativeConnectivity.onChange((state) => setConnectivity(state));
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => subscribeLocalModePreference(setForceLocalModeState), []);
  useEffect(() => subscribeAppModePreference((mode) => setAppModeOffline(mode === 'offline')), []);

  const removeFileAt = (idx) => setAIFiles((prev) => prev.filter((_, i) => i !== idx));

  const send = async () => {
    const text = input.trim();
    if ((!text && aiFiles.length === 0) || loading) return;

    setInput('');
    inputRef.current && (inputRef.current.style.height = 'auto');

    const firstImage = aiFiles.find((f) => f.type === 'image');
    const userMsg = {
      role: 'user',
      content: text || aiFiles.map((f) => `[${f.filename}]`).join(' '),
      ...(firstImage ? { imageData: { blobUrl: firstImage.blobUrl, filename: firstImage.filename } } : {}),
    };

    const currentFiles = aiFiles;
    setAIFiles([]);
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);

    if (isOffline) {
      try {
        const attachmentContext = currentFiles
          .filter((f) => f.type !== 'image')
          .map(describeStructuredUpload)
          .filter(Boolean)
          .join('\n\n');
        const normalized = await routeConsultChat({
          isOffline: true,
          nativeAIQuery: nativeAI.query,
          chatText: text,
          attachmentContext,
        });
        const content = normalized.structured ? formatLocalAIResult(t, normalized.structured) : normalized.content;
        setMessages(prev => [...prev, { role: 'assistant', content, engine: normalized.engine }]);
      } catch (e) {
        const msg = e instanceof AllEnginesUnavailableError ? t('errAllEnginesUnavailable') : e.message;
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠ ${msg}`, error: true, engine: ENGINE.LOCAL_DATA }]);
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const history = newMessages.slice(-21, -1).map(m => ({ role: m.role, content: m.content }));
      const firstImageForApi = currentFiles.find((f) => f.type === 'image');
      const imageApiData = firstImageForApi ? { base64: firstImageForApi.base64, mimetype: firstImageForApi.mimetype } : null;
      const docContext = currentFiles
        .filter((f) => f.type !== 'image')
        .map(describeStructuredUpload)
        .join('\n\n');

      let streamingStarted = false;
      const r = await api.chatConsult(
        text || `Ekli dosyalari analiz et: ${currentFiles.map((f) => f.filename).join(', ')}`,
        history,
        docContext || null,
        imageApiData,
        (_chunk, full) => {
          setLoading(false);
          setMessages((prev) => {
            if (!streamingStarted) {
              streamingStarted = true;
              return [...prev, { role: 'assistant', content: full, streaming: true, engine: ENGINE.CLOUD }];
            }
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], content: full };
            return next;
          });
        }
      );

      // item 18: r.complete is false when the stream ended without the
      // server's explicit completion marker (a dropped connection or a
      // provider erroring mid-answer) -- surfaced so a truncated reply
      // isn't mistaken for a complete one.
      const cutShort = r.complete === false;
      if (!streamingStarted) {
        setMessages(prev => [...prev, { role: 'assistant', content: r.content, engine: ENGINE.CLOUD, provider: r.provider, cutShort }]);
      } else {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: r.content, engine: ENGINE.CLOUD, provider: r.provider, cutShort };
          return next;
        });
      }
    } catch (e) {
      const msg = e.code === 'ALL_AI_PROVIDERS_FAILED' ? t('errAllProvidersFailed') : e.message;
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠ ${msg}`, error: true, engine: ENGINE.CLOUD }]);
    } finally {
      setLoading(false);
    }
  };

  const clear = () => {
    if (!window.confirm(t('consultClearConfirm'))) return;
    setMessages([]);
    setAIFiles([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const autoResize = (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px'; };

  return <div className="flex flex-col bg-navy-light/70 border border-gold/30 rounded-lg overflow-hidden" style={{ height: 'calc(100dvh - 200px)', minHeight: 400 }}>
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-gold/20 flex-shrink-0">
      <div className="flex items-center gap-2"><MessageSquare className="w-4 h-4 text-gold" /><span className="text-xs font-mono text-gold/70 tracking-widest uppercase">{t('consultTitle')}</span></div>
      <div className="flex items-center gap-2"><FileAttach onAIFile={handleAIFile} compact />{messages.length > 0 && <button onClick={clear} className="flex items-center gap-1 text-xs text-gold/40 hover:text-red-400 transition"><Trash2 className="w-3 h-3" /> {t('consultClear')}</button>}</div>
    </div>

    {aiFiles.length > 0 && <div className="flex-shrink-0 px-4 py-1.5 bg-cyan-900/20 border-b border-cyan-500/20 text-xs text-cyan-400 font-mono">📎 {aiFiles.length} {t('filesAttached')}</div>}

    {isOffline && <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 bg-amber-900/20 border-b border-amber-500/20 text-xs text-amber-400"><WifiOff className="w-3 h-3 flex-shrink-0" /><span>{t('consultOfflineBanner')}</span></div>}

    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((m, i) => <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
        {m.role === 'assistant' && <span className="px-1"><EngineBadge engine={m.engine} /></span>}
        <div className={`rounded-xl px-4 py-2.5 text-sm leading-relaxed break-words ${m.role === 'user' ? 'bg-gold/20 text-gold border border-gold/30 rounded-tr-none' : m.error ? 'bg-red-950/40 text-red-400 border border-red-800/30 rounded-tl-none' : 'bg-navy/70 text-gold/90 border border-gold/15 rounded-tl-none report-content'}`}>{m.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> : <p className="whitespace-pre-wrap">{m.content}</p>}</div>
        {m.role === 'assistant' && m.cutShort && !m.streaming && <span className="px-1 text-xs text-amber-400">{t('streamCutShort')}</span>}
      </motion.div>)}
      {loading && <div className="text-gold/60 text-sm">{t('analyzing')}</div>}
    </div>

    {aiFiles.length > 0 && <div className="px-3 py-1 border-t border-gold/10 flex gap-2 flex-wrap">{aiFiles.map((f, i) => <button key={`${f.filename}-${i}`} onClick={() => removeFileAt(i)} className="text-xs bg-cyan-900/30 border border-cyan-500/30 text-cyan-300 rounded px-2 py-1">{f.filename} ×</button>)}</div>}

    <div className="flex-shrink-0 border-t border-gold/20 p-3 bg-navy/30"><div className="flex gap-2 items-end"><textarea ref={inputRef} value={input} onChange={e => { setInput(e.target.value); autoResize(e); }} onKeyDown={handleKey} placeholder={t('consultPlaceholder')} rows={1} className="flex-1 bg-navy/80 border border-gold/30 rounded-lg px-3 py-2.5 text-gold/90 text-sm font-serif focus:border-gold focus:outline-none resize-none" style={{ minHeight: 42, maxHeight: 128 }} /><VoiceButton mode="input" onTranscript={text => setInput(prev => prev ? prev + ' ' + text : text)} size="sm" /><button onClick={send} disabled={(!input.trim() && aiFiles.length === 0) || loading} aria-label={t('sendBtn')} className="btn-gold h-10 w-10 rounded-lg flex items-center justify-center disabled:opacity-40 flex-shrink-0">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}</button></div></div>
  </div>;
}
