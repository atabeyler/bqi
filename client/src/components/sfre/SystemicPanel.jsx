import React, { useEffect, useState } from 'react';
import { useLang } from '../../services/langContext.jsx';
import { sfreApi } from '../../services/api.js';
import { SYSTEMIC_SAMPLE } from './systemicSample.js';

const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(x) : '—');
const List = ({ title, items }) => (items?.length ? (<div><div className="text-[11px] uppercase tracking-wider text-cyan-100/60">{title}</div><ul className="list-disc ms-5 text-xs text-slate-300">{items.map((x) => (<li key={x}>{x}</li>))}</ul></div>) : null);

// Describes the vNext engines (from GET /capabilities) and renders one Digital Twin run stage by stage. Computes nothing itself.
export default function SystemicPanel({ setError }) {
  const { t } = useLang();
  const [caps, setCaps] = useState(null);
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; sfreApi.capabilities().then((c) => { if (alive) setCaps(c); }).catch((e) => { if (alive) setError?.(e?.message || ''); }); return () => { alive = false; }; }, [setError]);
  async function runTwin() {
    setBusy(true); setError?.('');
    try { setOut(await sfreApi.run(SYSTEMIC_SAMPLE)); } catch (e) { setOut(null); setError?.(e?.message || ''); } finally { setBusy(false); }
  }
  const twin = out?.results?.find((r) => r.model_id === 'M71.system_twin');
  const v = twin?.value;
  return (
    <div className="space-y-4" data-testid="sfre-systemic">
      <h2 className="font-semibold">{t('sfre_sys_title')}</h2>
      <p className="text-sm text-amber-200/90" role="note">{t('sfre_sys_intro')}</p>
      <p className="text-xs text-cyan-100/80 break-words">{t('sfre_sys_flow')}</p>
      {!caps && <p className="text-sm text-slate-400">{t('sfre_sys_loading')}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {caps?.capabilities?.map((c) => (
          <article key={c.engine} className="border border-cyan-300/25 rounded p-3 space-y-2" aria-label={c.title}>
            <h3 className="font-medium text-cyan-50">{c.title}</h3>
            <p className="text-xs text-slate-300">{c.summary}</p>
            <div className="text-[11px] text-amber-300">{t('sfre_sys_nonprod')}</div>
            <List title={t('sfre_sys_models')} items={c.models.map((m) => `${m.model_id} (${m.state})`)} />
            <List title={t('sfre_sys_needs')} items={c.needs} />
            <List title={t('sfre_sys_assumptions')} items={c.assumptions} />
            <List title={t('sfre_sys_limits')} items={c.limitations} />
          </article>
        ))}
      </div>
      <div>
        <button type="button" disabled={busy} onClick={runTwin} className="border border-cyan-300/50 px-5 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{busy ? t('sfre_sys_running') : t('sfre_sys_run_twin')}</button>
      </div>
      {v && (
        <section className="border border-cyan-300/25 rounded p-3 space-y-3 text-sm" aria-live="polite" data-testid="sfre-twin-result">
          <div>{twin.status} · {twin.calibration} · {t('sfre_sys_system_loss')}: <b className="tabular-nums">{fmt(v.system.systemLoss)}</b> · {t('sfre_sys_defaults')}: <b>{v.system.defaults}</b> · {t('sfre_sys_rounds')}: <b>{v.rounds}</b></div>
          <ol className="list-decimal ms-5 space-y-1">
            {v.stages.map((s) => (<li key={s.stage}><b>{s.stage}</b>{s.perRound ? ` · ${s.perRound.length}×` : ''}{s.totalSold !== undefined ? ` · ${fmt(s.totalSold)}` : ''}{s.systemLoss !== undefined ? ` · ${fmt(s.systemLoss)}` : ''}{s.directLoss !== undefined ? ` · ${fmt(s.directLoss)}` : ''}</li>))}
          </ol>
          <div>
            <div className="font-medium">{t('sfre_sys_ledger')} — {v.reconciliation.reconciled ? t('sfre_sys_reconciled') : t('sfre_sys_not_reconciled')}</div>
            <table className="text-xs mt-1"><tbody>
              {Object.entries(v.channels).filter(([, x]) => Math.abs(x) > 1e-9).map(([k, x]) => (<tr key={k}><td className="pe-3">{k}</td><td className="tabular-nums text-end">{fmt(x)}</td></tr>))}
            </tbody></table>
          </div>
          <List title={t('sfre_sys_unobserved')} items={twin.unobserved} />
          <List title={t('sfre_sys_dataflow')} items={v.dataflow.map((d) => `${d.from} → ${d.to}: ${d.field}`)} />
        </section>
      )}
    </div>
  );
}
