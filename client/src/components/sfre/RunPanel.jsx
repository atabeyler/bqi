import React, { useEffect, useState } from 'react';
import { useLang } from '../../services/langContext.jsx';
import { sfreApi } from '../../services/api.js';

const ENGINES = ['cascade', 'concentration', 'overlap', 'counterfactual'];
const today = () => new Date().toISOString().slice(0, 10);
const input = 'bg-black/40 border border-cyan-300/25 rounded px-2 py-2 min-h-[44px] w-full';

export default function RunPanel({ onResult, setError }) {
  const { t } = useLang();
  const [asOf, setAsOf] = useState(today());
  const [universe, setUniverse] = useState(null);
  const [shocks, setShocks] = useState([{ asset: '', pct: 10 }]);
  const [reds, setReds] = useState([]);
  const [engines, setEngines] = useState(['cascade', 'concentration']);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true; setUniverse(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return undefined;
    sfreApi.universe(asOf).then((u) => { if (live) setUniverse(u); }).catch(() => { if (live) setUniverse({ funds: [], assets: [] }); });
    return () => { live = false; };
  }, [asOf]);

  const toggle = (e) => setEngines((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  const setRow = (setter, i, patch) => setter((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function submit(ev) {
    ev.preventDefault(); setBusy(true); setError('');
    try {
      const priceShocks = {}; for (const s of shocks) if (s.asset && Number(s.pct) > 0) priceShocks[s.asset] = Math.min(100, Number(s.pct)) / 100;
      const redemptions = {}; for (const r of reds) if (r.fund && Number(r.pct) > 0) redemptions[r.fund] = { fraction: Math.min(100, Number(r.pct)) / 100 };
      onResult(await sfreApi.runFromData({ asOf, seed: Number(seed), engines, scenario: { priceShocks, redemptions } }));
    } catch (e) { onResult(null); setError(e?.message || t('sfre_error_generic')); } finally { setBusy(false); }
  }

  const noData = universe && universe.funds.length === 0;
  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">{t('sfre_as_of')}
          <input type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} className={`${input} mt-1`} aria-describedby="sfre-asof-hint" />
          <span id="sfre-asof-hint" className="text-xs text-slate-400">{t('sfre_as_of_hint')}</span>
        </label>
        <label className="block text-sm">{t('sfre_seed')}
          <input type="number" min="0" step="1" required value={seed} onChange={(e) => setSeed(e.target.value)} className={`${input} mt-1`} aria-describedby="sfre-seed-hint" />
          <span id="sfre-seed-hint" className="text-xs text-slate-400">{t('sfre_seed_hint')}</span>
        </label>
      </div>
      <p className="text-sm" role="status">
        {universe ? `${universe.funds.length} ${t('sfre_universe_funds')} · ${universe.assets.length} ${t('sfre_universe_assets')}` : '…'}
        {noData && <span className="block text-amber-300">{t('sfre_no_universe')}</span>}
      </p>

      <fieldset className="space-y-2">
        <legend className="font-semibold">{t('sfre_shocks')}</legend>
        {shocks.map((s, i) => (
          <div key={`s${i}`} className="grid grid-cols-[1fr_6rem_auto] gap-2 items-end">
            <label className="text-xs">{t('sfre_asset')}
              <select value={s.asset} onChange={(e) => setRow(setShocks, i, { asset: e.target.value })} className={`${input} mt-1`}>
                <option value="" />{(universe?.assets || []).map((a) => (<option key={a} value={a}>{a.replace('BIST:', '')}</option>))}
              </select>
            </label>
            <label className="text-xs">{t('sfre_decline_pct')}
              <input type="number" min="0" max="100" step="0.5" value={s.pct} onChange={(e) => setRow(setShocks, i, { pct: e.target.value })} className={`${input} mt-1`} />
            </label>
            <button type="button" className="underline min-h-[44px] px-2" onClick={() => setShocks((r) => r.filter((_, k) => k !== i))}>{t('sfre_remove')}</button>
          </div>
        ))}
        <button type="button" className="underline min-h-[44px]" onClick={() => setShocks((r) => [...r, { asset: '', pct: 10 }])}>+ {t('sfre_add_shock')}</button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-semibold">{t('sfre_redemptions')}</legend>
        {reds.map((r, i) => (
          <div key={`r${i}`} className="grid grid-cols-[1fr_6rem_auto] gap-2 items-end">
            <label className="text-xs">{t('sfre_fund')}
              <select value={r.fund} onChange={(e) => setRow(setReds, i, { fund: e.target.value })} className={`${input} mt-1`}>
                <option value="" />{(universe?.funds || []).map((f) => (<option key={f} value={f}>{f.replace('FUND:', '')}</option>))}
              </select>
            </label>
            <label className="text-xs">{t('sfre_redemption_pct')}
              <input type="number" min="0" max="100" step="0.5" value={r.pct} onChange={(e) => setRow(setReds, i, { pct: e.target.value })} className={`${input} mt-1`} />
            </label>
            <button type="button" className="underline min-h-[44px] px-2" onClick={() => setReds((x) => x.filter((_, k) => k !== i))}>{t('sfre_remove')}</button>
          </div>
        ))}
        <button type="button" className="underline min-h-[44px]" onClick={() => setReds((r) => [...r, { fund: '', pct: 20 }])}>+ {t('sfre_add_redemption')}</button>
      </fieldset>

      <fieldset>
        <legend className="font-semibold mb-1">{t('sfre_engines')}</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {ENGINES.map((e) => (<label key={e} className="flex items-center gap-2 min-h-[44px] text-sm"><input type="checkbox" checked={engines.includes(e)} onChange={() => toggle(e)} />{t(`sfre_eng_${e}`)}</label>))}
        </div>
      </fieldset>

      <p className="text-xs text-slate-400">{t('sfre_run_note')}</p>
      <button type="submit" disabled={busy || noData || engines.length === 0} className="border border-cyan-300/50 px-5 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{busy ? t('sfre_running') : t('sfre_run')}</button>
    </form>
  );
}
