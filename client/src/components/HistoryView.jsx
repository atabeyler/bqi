import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, FileText, Eye, Loader2, Search, FileDown, Share2, Trash2 } from 'lucide-react';
import { api, getToken } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';
import { shareOrDownloadBlob } from '../services/shareFile.js';
import { isNativeApp, nativeAnalyses, nativeAuth, nativePlatform } from '../services/nativeBridge.js';
import DecisionTracePanel from './DecisionTracePanel.jsx';

// Mirrors server/src/routes/history.js's own engineLabelFor(): aiProvider on
// a local row is either a real upstream cloud-provider name (pulled down
// from a cloud-generated row synced from elsewhere -- never shown as-is) or
// one of the local engine's own already-public labels, written verbatim by
// this device's Model Manager / offline-extractive path (see
// AnalysisView.jsx's providerLabel). Duplicated rather than shared because
// this module runs in the browser/WebView while history.js runs on the
// server -- same reasoning as e.g. arrayBufferToBase64 being duplicated
// between desktopBridge.js/mobileBridge.js.
const LOCAL_ENGINE_LABELS = new Set(['Q LOCAL', 'Q LOCAL DATA']);
function engineLabelFor(aiProvider) {
  if (!aiProvider) return null;
  return LOCAL_ENGINE_LABELS.has(aiProvider) ? aiProvider : 'Q CLOUD';
}

// Mirrors server/src/routes/history.js's PLATFORM_DISPLAY_LABELS.
const PLATFORM_DISPLAY_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' };

// Local SQLite rows carry the real deviceId of whichever device originally
// created them (this device's own creates, or another device's rows
// pulled down by sync -- see desktop/mobile's entityHandlers.js), but
// there is no local copy of the server's `devices` directory to resolve a
// foreign id to a platform name from. So this can only ever be precise
// about two cases: the 'web' sentinel, and a row that matches THIS
// device's own id (nativeAuth.getDeviceId(), resolved once by the caller
// and passed in as `myDeviceId`) -- anything else is honestly labelled as
// just "another synced device" rather than guessing a platform for it.
function localDeviceLabel(deviceId, myDeviceId, t) {
  if (!deviceId || deviceId === 'web') return t('historyDeviceWeb');
  if (deviceId === myDeviceId) {
    const platformLabel = PLATFORM_DISPLAY_LABELS[nativePlatform] || nativePlatform;
    return `${t('historyDeviceThisDevice')}${platformLabel ? ` (${platformLabel})` : ''}`;
  }
  return t('historyDeviceOtherSynced');
}

function localRecordToHistoryJson(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    ai_provider: row.aiProvider,
    engine_label: engineLabelFor(row.aiProvider),
    device_id: row.deviceId,
    created_at: row.createdAt,
    preview: (row.content || '').slice(0, 200),
  };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function AuditPanel({ record, loading }) {
  if (loading) return <div className="text-xs text-gold/50 py-3">Audit information is loading…</div>;
  if (!record) return <div className="text-xs text-gold/40 py-3">No audit record is available for this analysis.</div>;
  return <DecisionTracePanel record={record} />;
}

export default function HistoryView({ showTitle = true }) {
  const { t } = useLang();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [auditRecord, setAuditRecord] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [myDeviceId, setMyDeviceId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    const listing = isNativeApp
      ? nativeAnalyses.list().then((rows) => (rows || []).map(localRecordToHistoryJson))
      : api.historyList();
    listing.then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, []);

  // Only needed to tell "this device"'s own rows apart from ones synced
  // down from elsewhere (see localDeviceLabel above) -- irrelevant on the
  // web build, where every row already carries a server-computed
  // device_label instead.
  useEffect(() => {
    if (!isNativeApp) return;
    nativeAuth.getDeviceId?.().then(setMyDeviceId).catch(() => {});
  }, []);

  const deviceLabel = (item) => (isNativeApp ? localDeviceLabel(item.device_id, myDeviceId, t) : item.device_label);

  const remove = async (id) => {
    if (!window.confirm(t('historyDeleteConfirm'))) return;
    setDeletingId(id);
    try {
      if (isNativeApp) await nativeAnalyses.remove(id); else await api.historyDelete(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
      setSelected((prev) => (prev?.id === id ? null : prev));
    } catch (e) {
      alert(`${t('errorPrefix')}: ${e.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const categories = useMemo(() => ['all', ...Array.from(new Set(items.map((i) => i.category).filter(Boolean)))], [items]);
  const categoryLabel = (c) => {
    if (c === 'all') return t('historyAllCategories');
    const key = `cat_${c.replace(/-/g, '_')}`;
    const label = t(key);
    return label === key ? c : label;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (!q) return true;
      return item.title?.toLowerCase().includes(q) || item.preview?.toLowerCase().includes(q) || item.category?.toLowerCase().includes(q);
    });
  }, [items, query, category]);

  const loadAudit = async (id) => {
    setAuditLoading(true); setAuditRecord(null);
    try {
      const token = getToken();
      const response = await fetch(`/api/v1/platform/decisions/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) return;
      const data = await response.json();
      setAuditRecord(data.record || null);
    } catch { setAuditRecord(null); }
    finally { setAuditLoading(false); }
  };

  const view = async (id) => {
    try {
      const a = isNativeApp ? localRecordToHistoryJson(await nativeAnalyses.get(id)) : await api.historyGet(id);
      setSelected(a);
      if (!isNativeApp) loadAudit(id);
    } catch (e) { alert(`${t('errorPrefix')}: ${e.message}`); }
  };

  const closeSelected = () => { setSelected(null); setAuditRecord(null); setAuditLoading(false); };
  const download = async (id) => { try { const { blob, filename } = await api.historyDownloadBlob(id); triggerDownload(blob, filename || `BQI_${id}.docx`); } catch (e) { alert(`${t('errorPrefix')}: ${e.message}`); } };
  const downloadPdf = async (id) => { try { const { blob, filename } = await api.historyDownloadPdfBlob(id); triggerDownload(blob, filename || `BQI_${id}.pdf`); } catch (e) { alert(`${t('errorPrefix')}: ${e.message}`); } };
  const share = async (id, title) => { try { const { blob, filename } = await api.historyDownloadPdfBlob(id); await shareOrDownloadBlob(blob, filename || `BQI_${id}.pdf`, 'application/pdf', title || 'BQI Raporu'); } catch (e) { alert(`${t('errorPrefix')}: ${e.message}`); } };

  return (
    <div className="max-w-6xl mx-auto">
      {showTitle && <h2 className="text-2xl font-display text-gold tracking-widest mb-6">{t('pastAnalyses')}</h2>}
      {!loading && items.length > 0 && <div className="flex flex-col sm:flex-row gap-2 mb-4"><div className="relative flex-1"><Search className="w-3.5 h-3.5 text-gold/40 absolute left-3 top-1/2 -translate-y-1/2" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('historySearchPh')} className="w-full bg-navy-light/70 border border-gold/20 rounded pl-8 pr-3 py-2 text-sm text-gold placeholder:text-gold/30 focus:border-gold/50 outline-none" /></div><select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-navy-light/70 border border-gold/20 rounded px-3 py-2 text-sm text-gold outline-none focus:border-gold/50">{categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select></div>}
      {loading ? <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 text-gold animate-spin" /></div> : items.length === 0 ? <div className="text-center py-16 text-gold/40"><FileText className="w-12 h-12 mx-auto mb-3" />{t('noHistory')}</div> : filtered.length === 0 ? <div className="text-center py-16 text-gold/40"><Search className="w-12 h-12 mx-auto mb-3" />{t('historyNoResults')}</div> : <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{filtered.map((item) => <motion.div key={item.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-navy-light/70 border border-gold/20 hover:border-gold/50 rounded-lg p-4 transition"><div className="flex items-start justify-between mb-2"><div className="flex-1"><div className="text-xs tracking-[0.3em] uppercase text-gold/50 mb-1">{categoryLabel(item.category)} · {new Date(item.created_at).toLocaleString(t('locale'))}</div><div className="text-[11px] tracking-widest uppercase text-gold/40 mb-1">{[item.engine_label, deviceLabel(item)].filter(Boolean).join(' · ')}</div><h3 className="text-gold font-display tracking-wide leading-tight">{item.title}</h3><p className="text-xs text-gold/60 mt-2 line-clamp-2">{item.preview?.replace(/[#*]/g, '')}...</p></div></div><div className="flex gap-2 mt-3"><button onClick={() => view(item.id)} className="flex-1 border border-gold/40 text-gold px-3 py-1.5 rounded text-xs tracking-widest hover:bg-gold/10 flex items-center justify-center gap-2"><Eye className="w-3 h-3" /> {t('view')}</button><button onClick={() => download(item.id)} className="flex-1 btn-gold px-3 py-1.5 rounded text-xs tracking-widest flex items-center justify-center gap-2"><Download className="w-3 h-3" /> {t('download')}</button><button onClick={() => downloadPdf(item.id)} title={t('historyDownloadPdfTitle')} className="border border-gold/40 text-gold px-2.5 py-1.5 rounded text-xs tracking-widest hover:bg-gold/10 flex items-center justify-center"><FileDown className="w-3 h-3" /></button><button onClick={() => share(item.id, item.title)} title={t('share')} className="border border-gold/40 text-gold px-2.5 py-1.5 rounded text-xs tracking-widest hover:bg-gold/10 flex items-center justify-center"><Share2 className="w-3 h-3" /></button><button onClick={() => remove(item.id)} disabled={deletingId === item.id} title={t('historyDeleteButton')} className="border border-red-400/40 text-red-300 px-2.5 py-1.5 rounded text-xs tracking-widest hover:bg-red-400/10 flex items-center justify-center disabled:opacity-40"><Trash2 className="w-3 h-3" /></button></div></motion.div>)}</div>}
      {selected && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 bg-black/80 backdrop-blur p-4 flex items-center justify-center" onClick={closeSelected}><motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()} className="bg-navy-light gold-glow-strong rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"><div className="p-4 border-b border-gold/30 flex items-center justify-between"><div><div className="text-xs uppercase tracking-widest text-gold/50">{categoryLabel(selected.category)}</div><div className="text-[11px] tracking-widest uppercase text-gold/40 mt-0.5">{[selected.engine_label, deviceLabel(selected)].filter(Boolean).join(' · ')}</div><h3 className="text-gold font-display tracking-wide">{selected.title}</h3></div><button onClick={closeSelected} className="text-gold/60 hover:text-gold text-2xl" aria-label={t('close') || 'Kapat'}>✕</button></div><div className="flex-1 overflow-auto p-6 report-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown><AuditPanel record={auditRecord} loading={auditLoading} /></div><div className="p-3 border-t border-gold/30 flex justify-end gap-2"><button onClick={() => remove(selected.id)} disabled={deletingId === selected.id} className="border border-red-400/40 text-red-300 px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2 hover:bg-red-400/10 disabled:opacity-40"><Trash2 className="w-4 h-4" /> {t('historyDeleteButton')}</button><button onClick={() => share(selected.id, selected.title)} className="border border-gold/40 text-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2 hover:bg-gold/10"><Share2 className="w-4 h-4" /> {t('share')}</button><button onClick={() => downloadPdf(selected.id)} className="border border-gold/40 text-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2 hover:bg-gold/10"><FileDown className="w-4 h-4" /> {t('historyDownloadPdfTitle')}</button><button onClick={() => download(selected.id)} className="btn-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2"><Download className="w-4 h-4" /> {t('downloadDocxBtn')}</button></div></motion.div></motion.div>}
    </div>
  );
}
