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

export default function DataPanel({ isAdmin, onChanged }) {
  const { t } = useLang();
  const [ingests, setIngests] = useState([]);
  const load = useCallback(() => { sfreApi.ingests().then((r) => setIngests(r.ingests || [])).catch(() => setIngests([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-5">
      <h2 className="font-semibold">{t('sfre_upload_title')}</h2>
      {!isAdmin && <p className="text-amber-300 text-sm" role="note">{t('sfre_admin_only')}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {KINDS.map(({ kind, key, defaultLag }) => (<UploadCard key={kind} kind={kind} k={key} defaultLag={defaultLag} enabled={isAdmin} onDone={() => { load(); onChanged?.(); }} />))}
      </div>
      <section aria-labelledby="sfre-ing-h">
        <h2 id="sfre-ing-h" className="font-semibold mb-1">{t('sfre_recent_ingests')}</h2>
        <ul className="text-sm space-y-1 list-none p-0 m-0">
          {ingests.map((i) => (<li key={i.id} className="break-words">{i.kind} · {i.filename} · <span className="tabular-nums">{i.inserted}</span> {t('sfre_inserted')} · <span className="tabular-nums">{i.duplicates}</span> {t('sfre_duplicates')}</li>))}
        </ul>
      </section>
    </div>
  );
}
