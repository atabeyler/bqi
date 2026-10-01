import React, { useState } from 'react';
import { useLang } from '../../services/langContext.jsx';
import { sfreApi } from '../../services/api.js';
import { StackedBar, RoundsChart, PALETTE } from './charts.jsx';

const TONE = {
  SIGNAL: 'text-red-300', COMPUTATION_FAILED: 'text-red-300', MODEL_DISAGREEMENT: 'text-amber-300', INSUFFICIENT_OBSERVABILITY: 'text-amber-300',
  INSUFFICIENT_DATA: 'text-amber-300', MODEL_UNCERTAIN: 'text-amber-300', UNCALIBRATED: 'text-slate-300', NO_SIGNAL: 'text-slate-300', MEASURED: 'text-cyan-200',
};
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

function LossCharts({ cascade, t }) {
  const sys = cascade?.value?.system; if (!sys) return null;
  const who = [['direct', 'sfre_direct'], ['selfImpact', 'sfre_self_impact'], ['commonAsset', 'sfre_common_asset'], ['counterparty', 'sfre_counterparty']].map(([k, l]) => ({ key: k, label: t(l), value: sys.byWho[k], color: PALETTE[k] }));
  const why = [['direct', 'sfre_direct'], ['liquidity', 'sfre_liquidity'], ['redemption', 'sfre_redemption'], ['margin', 'sfre_margin'], ['counterparty', 'sfre_counterparty']].map(([k, l]) => ({ key: k, label: t(l), value: sys.byWhy[k], color: PALETTE[k] }));
  const rounds = cascade.value.rounds.map((r) => ({ round: r.round, sales: sum(r.sold), loss: sum(r.loss) }));
  return (
    <section className="space-y-4" aria-labelledby="sfre-loss-h">
      <h2 id="sfre-loss-h" className="font-semibold">{t('sfre_loss_title')}</h2>
      <p className="text-sm">
        {t('sfre_loss_total')}: <b className="tabular-nums">{new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(sys.totalLoss)}</b> ({(sys.lossFractionOfNav * 100).toFixed(2)}% {t('sfre_loss_share_nav')}) · {sys.reconciled ? t('sfre_reconciled') : ''}
      </p>
      {cascade.value.lowerBound && <p className="text-amber-300 text-sm" role="note">{t('sfre_lower_bound')}</p>}
      <div className="grid gap-6 md:grid-cols-2">
        <StackedBar title={t('sfre_by_who')} segments={who} total={sys.totalLoss} tableLabel={t('sfre_table_alt')} />
        <StackedBar title={t('sfre_by_why')} segments={why} total={sys.totalLoss} tableLabel={t('sfre_table_alt')} />
      </div>
      <RoundsChart title={t('sfre_rounds_title')} rounds={rounds} salesLabel={t('sfre_forced_sales')} lossLabel={t('sfre_loss_total')} roundLabel={t('sfre_round')} tableLabel={t('sfre_table_alt')} />
    </section>
  );
}

export default function ResultsPanel({ out, setError }) {
  const { t } = useLang();
  const [evidence, setEvidence] = useState(null);
  async function explain(result) {
    const claimId = out.claims?.[result.result_hash]; if (!claimId) return;
    try { setEvidence(await sfreApi.explain(claimId)); } catch (e) { setError(e?.message || t('sfre_error_generic')); }
  }
  const cascade = out.results.find((r) => r.engine === 'cascade');
  return (
    <div className="space-y-6" data-testid="sfre-results">
      <div className="text-sm break-words">
        {t('sfre_run_id')} <code>{out.run.run_id}</code> · seed {out.run.random_seed} · {t('sfre_result_hash')} <code>{out.run.result_hash.slice(0, 16)}</code> · <b>{out.production_status === 'NON_PRODUCTION' ? t('sfre_non_production') : out.production_status}</b>
      </div>
      {out.data && (
        <div className="text-sm space-y-1">
          <div>{t('sfre_funds_used')}: <b>{out.data.funds}</b> · {t('sfre_universe_assets')}: <b>{out.data.assets}</b></div>
          {out.data.fundsSkipped?.length > 0 && (
            <details className="text-amber-300"><summary>{t('sfre_funds_skipped')}: {out.data.fundsSkipped.length}</summary>
              <ul className="ms-5 list-disc">{out.data.fundsSkipped.slice(0, 20).map((s) => (<li key={s.fund}>{s.fund}: {t('sfre_missing')} {s.missing.join(', ')}</li>))}</ul>
            </details>
          )}
        </div>
      )}
      <LossCharts cascade={cascade} t={t} />
      {/* small screens: one card per result (no horizontal scrolling); sm+: table */}
      <ul className="sm:hidden space-y-3 list-none p-0 m-0">
        {out.results.map((r) => (
          <li key={r.result_hash} className="border border-white/15 rounded p-3 text-sm space-y-1">
            <div className="font-medium">{r.engine}{r.parameters?.entity ? ` · ${String(r.parameters.entity).replace('FUND:', '')}` : ''} <span className="text-xs text-slate-400">{r.model_id}</span></div>
            <div className={`text-xs ${TONE[r.status] || ''}`}>{r.status}</div>
            <div className="text-xs text-slate-300">{r.calibration} · {t('sfre_col_coverage')}: {r.coverage ? `${(r.coverage.fraction * 100).toFixed(r.coverage.fraction === 1 ? 0 : 1)}%` : 'n/a'} · {t('sfre_col_unobserved')}: {r.unobserved.length}</div>
            <button type="button" className="underline min-h-[44px]" onClick={() => explain(r)}>{t('sfre_why')}</button>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead><tr className="text-start text-slate-400">{['sfre_col_engine', 'sfre_col_model', 'sfre_col_status', 'sfre_col_calibration', 'sfre_col_coverage', 'sfre_col_unobserved'].map((k) => (<th key={k} scope="col" className="text-start py-1 pe-3">{t(k)}</th>))}<th /></tr></thead>
          <tbody>
            {out.results.map((r) => (
              <tr key={r.result_hash} className="border-t border-white/10">
                <td className="py-1 pe-3 align-top">{r.engine}{r.parameters?.entity ? <span className="block text-xs text-slate-400">{String(r.parameters.entity).replace('FUND:', '')}</span> : null}</td>
                <td className="pe-3 align-top">{r.model_id}</td><td className={`pe-3 align-top ${TONE[r.status] || ''}`}>{r.status}</td><td className="pe-3 align-top">{r.calibration}</td>
                <td className="pe-3 tabular-nums align-top">{r.coverage ? `${(r.coverage.fraction * 100).toFixed(r.coverage.fraction === 1 ? 0 : 1)}%` : 'n/a'}</td><td className="pe-3 tabular-nums align-top">{r.unobserved.length}</td>
                <td className="align-top"><button type="button" className="underline" onClick={() => explain(r)}>{t('sfre_why')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="sfre-retail-h">
        <h2 id="sfre-retail-h" className="font-semibold mb-1">{t('sfre_retail_title')}</h2>
        <p className="text-xs text-slate-400 mb-2">{out.retail_table.disclaimer}</p>
        <table className="w-full text-sm border-collapse"><tbody>
          {out.retail_table.rows.map((row) => (<tr key={row.key} className="border-t border-white/10"><td className="py-1 pe-3">{row.label}</td><td className={`text-end text-xs sm:text-sm ${TONE[row.status] || ''}`}>{row.status}</td></tr>))}
        </tbody></table>
      </section>
      {evidence && (
        <section className="border border-cyan-300/25 rounded p-3 text-sm" aria-live="polite">
          <h2 className="font-semibold">{t('sfre_evidence_title')} ({t('sfre_chain_valid')}: {String(evidence.chain_valid)})</h2>
          <ol className="list-decimal ms-5 mt-1">{evidence.path.map((n) => (<li key={n.id}><b>{n.kind}</b> <code className="text-xs">{n.hash.slice(0, 12)}</code></li>))}</ol>
        </section>
      )}
    </div>
  );
}
