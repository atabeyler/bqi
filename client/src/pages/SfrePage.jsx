import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import SplashScreen from '../components/SplashScreen.jsx';
import { useLang } from '../services/langContext.jsx';
import { sfreApi } from '../services/api.js';
import RunPanel from '../components/sfre/RunPanel.jsx';
import DataPanel from '../components/sfre/DataPanel.jsx';
import ReportsPanel from '../components/sfre/ReportsPanel.jsx';
import ResultsPanel from '../components/sfre/ResultsPanel.jsx';
import SystemicPanel from '../components/sfre/SystemicPanel.jsx';

// BFI (BOLD Financial Intelligence) console, internally "sfre" (routes, API, docs). Every number shown comes from the server's typed engine results; this page computes nothing.
const SAMPLE = {
  seed: 1, engines: ['cascade', 'concentration', 'overlap'],
  fundSystem: {
    assets: [{ id: 'A', price: 10, illiq: 1e-8 }, { id: 'B', price: 20, illiq: 2e-8 }], impact: { model: 'amihud-linear' },
    funds: [
      { id: 'F1', cash: 1e6, debt: null, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }, { asset: 'B', shares: 1e6 }] },
      { id: 'F2', cash: 5e5, debt: null, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 3e6 }] },
    ],
  },
  scenario: { priceShocks: { A: 0.1 }, redemptions: { F1: { fraction: 0.3 } } },
};
const TABS = ['run', 'data', 'systemic', 'reports', 'advanced'];

export default function SfrePage({ user }) {
  const { t } = useLang();
  const isAdmin = !!user?.isAdmin || user?.role === 'admin';
  const [tab, setTab] = useState('run');
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [data, setData] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false); // false until both status calls settled, so "no data yet" is never shown while loading
  const [text, setText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [busy, setBusy] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);

  const refresh = useCallback(() => {
    const h = sfreApi.health().then(setHealth).catch(() => setHealth(null));
    const d = sfreApi.dataStatus().then(setData).catch(() => setData(null));
    Promise.all([h, d]).then(() => setStatusLoaded(true));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function runJson() {
    setBusy(true); setError('');
    try { setOut(await sfreApi.run(JSON.parse(text))); } catch (e) { setOut(null); setError(e?.message || t('sfre_error_generic')); } finally { setBusy(false); }
  }
  const onResult = (r) => { setOut(r); if (r) refresh(); };

  const datasets = data?.datasets ?? [];
  const observations = datasets.reduce((sum, d) => sum + (d.n || 0), 0);
  const kpis = [
    { key: 'storage', label: t('sfre_storage'), value: health ? health.storage : (statusLoaded ? t('sfre_unavailable') : '…') },
    { key: 'datasets', label: t('sfre_datasets'), value: datasets.length ? `${datasets.length} · ${observations.toLocaleString()}` : (statusLoaded ? '—' : '…') },
    { key: 'ledger', label: t('sfre_entries'), value: health ? `${health.ledger.length ?? 0} ${health.ledger.ok ? '✓' : '✗'}` : '—' },
    { key: 'models', label: t('sfre_models_nonprod'), value: health ? String(health.models) : '—' },
  ];

  if (!splashDone) {
    return <SplashScreen logoSrc="/bfi-logo.svg" acronym="BFI" fullName="BOLD FINANCIAL INTELLIGENCE" displayMs={3000} onComplete={finishSplash} />;
  }

  return (
    <div className="quantum-bg min-h-screen relative p-4 sm:p-6">
      <main className="relative z-10 max-w-6xl mx-auto space-y-4 text-slate-100">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/bfi-logo.svg" alt="BFI" className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 object-contain drop-shadow-[0_0_14px_rgba(34,211,238,.45)]" />
            <div className="min-w-0">
              <div className="font-display text-cyan-50 tracking-[0.3em] text-sm sm:text-base">BFI</div>
              <h1 lang="en" className="text-lg sm:text-xl font-semibold">BOLD Financial Intelligence</h1>
              <div className="text-xs text-cyan-100/70">{t('sfre_title')}</div>
            </div>
          </div>
          <Link to="/" className="border border-cyan-300/35 text-cyan-100 px-3 py-2 min-h-[44px] rounded flex items-center gap-2 hover:bg-cyan-400/10">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" aria-hidden="true" /> {t('sfre_dashboard')}
          </Link>
        </div>
        <p className="text-sm text-slate-300">{t('sfre_subtitle')}</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="bfi-kpis">
          {kpis.map((k) => (
            <div key={k.key} className="border border-cyan-300/25 rounded p-3 bg-cyan-400/5">
              <div className="text-[11px] uppercase tracking-wider text-cyan-100/60">{k.label}</div>
              <div className="text-xl font-semibold text-cyan-50 mt-1 break-words">{k.value}</div>
            </div>
          ))}
        </div>

        <div className="border border-cyan-300/25 rounded p-3 text-sm space-y-2" data-testid="sfre-status">
          <div>
            {t('sfre_storage')}: <b>{health ? health.storage : t('sfre_unavailable')}</b>
            {health && <> · {health.ledger.ok ? t('sfre_ledger_ok') : t('sfre_ledger_broken')} ({health.ledger.length ?? 0} {t('sfre_entries')}) · {health.models} {t('sfre_models_nonprod')}</>}
          </div>
          {health && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{t('sfre_providers')}:</span>
              {health.providers.map((p) => (<span key={p.id} className={p.configured ? 'text-cyan-200' : 'text-amber-300'}>{p.id}: {p.configured ? t('sfre_configured') : t('sfre_not_configured')}</span>))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>{t('sfre_datasets')}:</span>
            {data?.datasets?.length ? data.datasets.map((d) => (<span key={`${d.source}/${d.field}`}>{d.source}/{d.field} ({d.n})</span>)) : <span className={statusLoaded ? 'text-amber-300' : 'text-slate-400'}>{statusLoaded ? t('sfre_no_datasets') : t('sfre_loading')}</span>}
          </div>
        </div>

        <div role="tablist" aria-label="BFI" className="flex flex-wrap gap-2">
          {TABS.map((k) => (
            <button key={k} role="tab" id={`sfre-tab-${k}`} aria-selected={tab === k} aria-controls={`sfre-panel-${k}`} type="button" onClick={() => setTab(k)}
              className={`px-4 py-2 min-h-[44px] rounded border ${tab === k ? 'border-cyan-300 bg-cyan-400/15' : 'border-cyan-300/25'}`}>{t(`sfre_tab_${k}`)}</button>
          ))}
        </div>

        <div role="tabpanel" id={`sfre-panel-${tab}`} aria-labelledby={`sfre-tab-${tab}`} className="space-y-4">
          {tab === 'run' && <RunPanel onResult={onResult} setError={setError} />}
          {tab === 'data' && <DataPanel isAdmin={isAdmin} onChanged={refresh} />}
          {tab === 'systemic' && <SystemicPanel setError={setError} />}
          {tab === 'reports' && <ReportsPanel isAdmin={isAdmin} setError={setError} />}
          {tab === 'advanced' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">{t('sfre_json_hint')}</p>
              <textarea aria-label="BFI request JSON" className="w-full h-64 font-mono text-xs bg-black/40 border border-cyan-300/25 rounded p-2" value={text} onChange={(e) => setText(e.target.value)} />
              <button type="button" disabled={busy} onClick={runJson} className="border border-cyan-300/50 px-5 py-2 min-h-[44px] rounded hover:bg-cyan-400/10 disabled:opacity-50">{busy ? t('sfre_running') : t('sfre_run')}</button>
            </div>
          )}
        </div>

        {error && <div role="alert" className="text-red-300 text-sm break-words">{error}</div>}
        {out && tab !== 'data' && tab !== 'systemic' && <ResultsPanel out={out} setError={setError} />}
      </main>
    </div>
  );
}
