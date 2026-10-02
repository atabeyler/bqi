import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../../services/langContext.jsx';
import { sfreApi } from '../../services/api.js';

const KINDS = [
  { kind: 'tefas', key: 'tefas', defaultLag: 1 },
  { kind: 'bist-eod', key: 'bist_eod', defaultLag: null },
  { kind: 'free-float', key: 'free_float', defaultLag: 1 },
  { kind: 'holdings', key: 'holdings', defaultLag: 10 },
];

function UploadCard({ kind, k, defaultLag, enabled, onDone }) {
  const { t } = useLang();
  const [file, setFile] = useState(null);
  const [lag, setLag] = useState(defaultLag ?? '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr(''); setRes(null);
    try { const r = await sfreApi.upload(kind, file, defaultLag === null ? '' : lag); setRes(r); onDone(); } catch (e) { setErr(e?.message || t('sfre_error_generic')); } finally { setBusy(false); }
  }
  const id = `sfre-up-${kind}`;
  return (
    <section className="border border-cyan-300/25 rounded p-3 space-y-2" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="font-semibold">{t(`sfre_kind_${k}`)}</h3>
      <p className="text-xs text-slate-400">{t(`sfre_kind_${k}_hint`)}</p>
      <label className="block text-sm">{t('sfre_choose_file')}
        <input type="file" accept=".xlsx,.xls,.csv" disabled={!enabled} onChange={(e) => setFile(e.target.files?.[0] || null)} className="block mt-1 w-full min-h-[44px]" />
      </label>
      {defaultLag !== null && (
        <label className="block text-sm">{t('sfre_lag_days')}
          <input type="number" min="0" max="90" step="1" value={lag} onChange={(e) => setLag(e.target.value)} className="bg-black/40 border border-cyan-300/25 rounded px-2 py-2 min-h-[44px] w-28 ms-2" aria-describedby={`${id}-lag`} />
          <span id={`${id}-lag`} className="block text-xs text-slate-400">{t('sfre_lag_hint')}</span>
        </label>
      )}
      <button type="button" disabled={!enabled || !file || busy} onClick={go} className="border border-cyan-300/50 px-4 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{busy ? t('sfre_uploading') : t('sfre_upload')}</button>
      {err && <div role="alert" className="text-red-300 text-sm">{err}</div>}
      {res && (
        <div className="text-sm" role="status">
          <b className="tabular-nums">{res.inserted}</b> {t('sfre_inserted')} · <b className="tabular-nums">{res.duplicates}</b> {t('sfre_duplicates')} · <b className="tabular-nums">{res.rejected}</b> {t('sfre_rejected')}
          {res.skipped?.length > 0 && (<div className="text-amber-300">{t('sfre_skipped_sheets')}: {res.skipped.map((s) => `${s.sheet} (${s.reason})`).join('; ')}</div>)}
        </div>
      )}
    </section>
  );
}

// Locale-independent comparison: accents, dotted/dotless i and case do not matter ("sil" must match "SİL" in any browser language).
const fold = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLowerCase().trim();
const fmtBytes = (b) => (typeof b === 'number' && Number.isFinite(b) ? `${(b / 1048576).toFixed(1)} MB` : '—');

// Admin-only danger zone: drops all ingested observations (not users, runs, ledger or models). Needs the localised word typed.
function PurgeCard({ size, onDone }) {
  const { t } = useLang();
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState('');
  const ok = fold(word) === fold(t('sfre_purge_word'));
  async function go() {
    setBusy(true); setErr(''); setMsg(null);
    try { const r = await sfreApi.purge(); setMsg(`${t('sfre_purge_done')}: ${Number(r.removedRows).toLocaleString()} · ${fmtBytes(r.freedBytes)}`); setWord(''); onDone(); } catch (e) { setErr(e?.message || t('sfre_error_generic')); } finally { setBusy(false); }
  }
  return (
    <section className="border border-red-400/40 rounded p-3 space-y-2" aria-labelledby="sfre-purge-h" data-testid="sfre-purge">
      <h3 id="sfre-purge-h" className="font-semibold text-red-300">{t('sfre_purge_title')}</h3>
      <p className="text-xs text-slate-300">{t('sfre_purge_warn')}</p>
      <p className="text-xs text-slate-400">{t('sfre_storage_size')}: {fmtBytes(size?.observationsBytes)} · {fmtBytes(size?.databaseBytes)}</p>
      <label className="block text-sm">{t('sfre_purge_type')}: <b>{t('sfre_purge_word')}</b>
        <input type="text" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" className="block mt-1 bg-black/40 border border-red-400/40 rounded px-2 py-2 min-h-[44px] w-48" />
      </label>
      <button type="button" disabled={!ok || busy} onClick={go} className="border border-red-400/60 text-red-200 px-4 py-2 min-h-[44px] rounded hover:bg-red-500/10 disabled:opacity-40">{busy ? t('sfre_purge_busy') : t('sfre_purge_button')}</button>
      {err && <div role="alert" className="text-red-300 text-sm">{err}</div>}
      {msg && <div role="status" className="text-sm text-cyan-200">{msg}</div>}
    </section>
  );
}

// Results pushed by a local BFI node (heavy data and compute stay on that machine; only results reach the cloud).
function FederationList() {
  const { t } = useLang();
  const [items, setItems] = useState(null);
  useEffect(() => { sfreApi.federation().then((r) => setItems(r.items || [])).catch(() => setItems([])); }, []);
  return (
    <section aria-labelledby="sfre-fed-h" data-testid="sfre-federation">
      <h2 id="sfre-fed-h" className="font-semibold mb-1">{t('sfre_fed_title')}</h2>
      <p className="text-xs text-slate-400 mb-1">{t('sfre_fed_hint')}</p>
      {items === null ? <p className="text-sm text-slate-400">{t('sfre_loading')}</p> : items.length === 0 ? <p className="text-sm text-slate-400">{t('sfre_fed_empty')}</p> : (
        <ul className="text-sm space-y-1 list-none p-0 m-0">
          {items.map((i) => (<li key={i.id} className="break-words"><b>{i.title}</b> · {i.node} · {String(i.created_at).slice(0, 10)}{i.summary ? ` · ${i.summary}` : ''}</li>))}
        </ul>
      )}
    </section>
  );
}

export default function DataPanel({ isAdmin, onChanged }) {
  const { t } = useLang();
  const [ingests, setIngests] = useState([]);
  const [size, setSize] = useState(null);
  const load = useCallback(() => {
    sfreApi.ingests().then((r) => setIngests(r.ingests || [])).catch(() => setIngests([]));
    if (isAdmin) sfreApi.dataStatus().then((r) => setSize(r.size || null)).catch(() => setSize(null));
  }, [isAdmin]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-5">
      <h2 className="font-semibold">{t('sfre_upload_title')}</h2>
      {!isAdmin && <p className="text-amber-300 text-sm" role="note">{t('sfre_admin_only')}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {KINDS.map(({ kind, key, defaultLag }) => (<UploadCard key={kind} kind={kind} k={key} defaultLag={defaultLag} enabled={isAdmin} onDone={() => { load(); onChanged?.(); }} />))}
      </div>
      <FederationList />
      {isAdmin && <PurgeCard size={size} onDone={() => { load(); onChanged?.(); }} />}
      <section aria-labelledby="sfre-ing-h">
        <h2 id="sfre-ing-h" className="font-semibold mb-1">{t('sfre_recent_ingests')}</h2>
        <ul className="text-sm space-y-1 list-none p-0 m-0">
          {ingests.map((i) => (<li key={i.id} className={`break-words ${i.purged ? 'opacity-50 line-through' : ''}`}>{i.kind} · {i.filename} · <span className="tabular-nums">{i.inserted}</span> {t('sfre_inserted')} · <span className="tabular-nums">{i.duplicates}</span> {t('sfre_duplicates')}</li>))}
        </ul>
      </section>
    </div>
  );
}
