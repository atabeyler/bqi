import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../../services/langContext.jsx';
import { sfreApi } from '../../services/api.js';

const LEVEL_STYLE = { NORMAL: 'text-emerald-300 border-emerald-300/40', 'İZLEME': 'text-amber-300 border-amber-300/40', ALARM: 'text-red-300 border-red-300/50' };

// Opens report HTML (fetched with the user's session) in a new tab. The tab is opened first so the popup blocker treats it as a click result.
async function openHtml(id) {
  const w = window.open('', '_blank');
  try {
    const html = await sfreApi.reportHtml(id);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    if (w) w.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { w?.close(); throw e; }
}

export default function ReportsPanel({ isAdmin, setError }) {
  const { t } = useLang();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(() => sfreApi.reportsList().then((r) => setItems(r.reports || [])).catch((e) => { setItems([]); setError?.(e.message); }), [setError]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, done) => {
    setBusy(true); setMsg(''); setError?.('');
    try { await fn(); if (done) setMsg(done); } catch (e) { setError?.(e.message); } finally { setBusy(false); }
  };
  const archiveNow = () => run(async () => { await sfreApi.reportArchive(); await load(); }, t('sfre_rep_archived'));
  const remove = (id) => {
    if (confirmId !== id) { setConfirmId(id); return; }
    setConfirmId(null);
    run(async () => { await sfreApi.reportDelete(id); await load(); }, t('sfre_rep_deleted'));
  };

  return (
    <section aria-labelledby="sfre-rep-h" data-testid="sfre-reports" className="space-y-3">
      <h2 id="sfre-rep-h" className="font-semibold">{t('sfre_rep_title')}</h2>
      <p className="text-xs text-slate-400">{t('sfre_rep_hint')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => run(() => openHtml(null))} className="border border-cyan-300/50 px-4 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{t('sfre_rep_live')}</button>
        <button type="button" disabled={busy} onClick={archiveNow} className="border border-cyan-300/50 px-4 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{t('sfre_rep_archive_now')}</button>
      </div>
      {msg && <div role="status" className="text-sm text-cyan-200">{msg}</div>}
      {items === null ? <p className="text-sm text-slate-400">{t('sfre_loading')}</p> : items.length === 0 ? <p className="text-sm text-slate-400">{t('sfre_rep_empty')}</p> : (
        <ul className="space-y-2 list-none p-0 m-0">
          {items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-cyan-300/20 rounded px-3 py-2 text-sm">
              <span className={`border rounded px-2 py-0.5 text-xs font-semibold ${LEVEL_STYLE[r.level_tr] || ''}`}>{r.level_tr}</span>
              <span>{String(r.created_at).slice(0, 16).replace('T', ' ')} UTC</span>
              <span className="text-slate-400">{t('sfre_rep_col_date')}: {r.data_as_of || '–'}</span>
              <span className="text-slate-400">{t(`sfre_rep_trigger_${r.trigger}`)}</span>
              <span className="text-slate-500 text-xs">#{r.document_id}</span>
              <span className="ml-auto flex gap-2">
                <button type="button" disabled={busy} onClick={() => run(() => openHtml(r.id))} aria-label={`${t('sfre_rep_open')} ${r.document_id}`} className="border border-cyan-300/40 px-3 py-1 min-h-[36px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{t('sfre_rep_open')}</button>
                {isAdmin && <button type="button" disabled={busy} onClick={() => remove(r.id)} aria-label={`${t('sfre_rep_delete')} ${r.document_id}`} className={`border px-3 py-1 min-h-[36px] rounded disabled:opacity-50 ${confirmId === r.id ? 'border-red-300 bg-red-500/20 text-red-200' : 'border-red-300/40 text-red-300 hover:bg-red-500/10'}`}>{confirmId === r.id ? t('sfre_rep_delete_confirm') : t('sfre_rep_delete')}</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">{t('sfre_rep_note')}</p>
    </section>
  );
}
