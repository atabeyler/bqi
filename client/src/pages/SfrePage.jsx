import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { sfreApi } from '../services/api.js';

// SFRE console: runs the Systemic Financial Risk & Market Integrity Engine on a JSON request and shows
// typed engine results, the retail risk table (no score, no recommendation) and the evidence path of a claim.
// Every number shown comes from the server's typed results; this page computes nothing.
const SAMPLE = {
  seed: 1,
  engines: ['cascade', 'concentration', 'overlap'],
  fundSystem: {
    assets: [{ id: 'A', price: 10, illiq: 1e-8 }, { id: 'B', price: 20, illiq: 2e-8 }],
    impact: { model: 'amihud-linear' },
    funds: [
      { id: 'F1', cash: 1e6, debt: null, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }, { asset: 'B', shares: 1e6 }] },
      { id: 'F2', cash: 5e5, debt: null, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 3e6 }] },
    ],
  },
  scenario: { priceShocks: { A: 0.1 }, redemptions: { F1: { fraction: 0.3 } } },
};

const TONE = {
  SIGNAL: 'text-red-300', MODEL_DISAGREEMENT: 'text-amber-300', INSUFFICIENT_OBSERVABILITY: 'text-amber-300', INSUFFICIENT_DATA: 'text-amber-300',
  MODEL_UNCERTAIN: 'text-amber-300', COMPUTATION_FAILED: 'text-red-300', UNCALIBRATED: 'text-slate-300', NO_SIGNAL: 'text-slate-300', MEASURED: 'text-cyan-200',
};

export default function SfrePage() {
  const [text, setText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [health, setHealth] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    sfreApi.health().then(setHealth).catch(() => setHealth(null));
    sfreApi.dataStatus().then(setData).catch(() => setData(null));
  }, []);

  async function run() {
    setBusy(true); setError(''); setEvidence(null);
    try { setOut(await sfreApi.run(JSON.parse(text))); } catch (e) { setOut(null); setError(e?.message || String(e)); } finally { setBusy(false); }
  }

  async function explain(result) {
    const claimId = out?.claims?.[result.result_hash];
    if (!claimId) return;
    try { setEvidence(await sfreApi.explain(claimId)); } catch (e) { setError(e?.message || String(e)); }
  }

  return (
    <div className="quantum-bg min-h-screen relative p-4 sm:p-6">
      <div className="relative z-10 max-w-6xl mx-auto space-y-4 text-slate-100">
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-semibold">SFRE - Systemic Financial Risk and Market Integrity</h1>
          <Link to="/" className="border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded flex items-center gap-2 hover:bg-cyan-400/10">
            <ArrowLeft className="w-4 h-4" /> Dashboard
          </Link>
        </div>
        <p className="text-sm text-slate-300">
          Analytical measurements under stated uncertainty. Not investment advice. All models are UNCALIBRATED unless governance says otherwise; unobserved data is never treated as zero.
        </p>
        <div className="border border-cyan-300/25 rounded p-3 text-sm space-y-2" data-testid="sfre-status">
          <div>
            Storage: <b>{health ? health.storage : 'unavailable'}</b>
            {health && <> - evidence ledger {health.ledger.ok ? 'verified' : 'BROKEN'} ({health.ledger.length ?? 0} entries) - {health.models} models (all non-production until approved)</>}
          </div>
          {health && (
            <div>
              Data providers:{' '}
              {health.providers.map((p) => (<span key={p.id} className={`mr-3 ${p.configured ? 'text-cyan-200' : 'text-amber-300'}`}>{p.id}: {p.configured ? 'configured' : 'NOT CONFIGURED'}</span>))}
            </div>
          )}
          <div>
            Loaded datasets:{' '}
            {data && data.datasets && data.datasets.length
              ? data.datasets.map((d) => (<span key={`${d.source}/${d.field}`} className="mr-3">{d.source}/{d.field} ({d.n})</span>))
              : <span className="text-amber-300">none - no observations ingested yet (golden-case replay stays BLOCKED_NO_DATA)</span>}
          </div>
        </div>
        <textarea aria-label="SFRE request JSON" className="w-full h-64 font-mono text-xs bg-black/40 border border-cyan-300/25 rounded p-2" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" disabled={busy} onClick={run} className="border border-cyan-300/50 px-4 py-2 rounded hover:bg-cyan-400/10 disabled:opacity-50">{busy ? 'Running...' : 'Run'}</button>
        {error && <div role="alert" className="text-red-300 text-sm">{error}</div>}
        {out && (
          <div className="space-y-4">
            <div className="text-sm">Run <code>{out.run.run_id}</code> - seed {out.run.random_seed} - result hash <code>{out.run.result_hash.slice(0, 16)}</code> - <b>{out.production_status}</b></div>
            <table className="w-full text-sm border-collapse">
              <thead><tr className="text-left text-slate-400"><th>Engine</th><th>Model</th><th>Status</th><th>Calibration</th><th>Coverage</th><th>Unobserved</th><th /></tr></thead>
              <tbody>
                {out.results.map((r) => (
                  <tr key={r.result_hash} className="border-t border-white/10">
                    <td>{r.engine}</td><td>{r.model_id}</td><td className={TONE[r.status] || ''}>{r.status}</td><td>{r.calibration}</td>
                    <td>{r.coverage ? `${(r.coverage.fraction * 100).toFixed(r.coverage.fraction === 1 ? 0 : 1)}%` : 'n/a'}</td><td>{r.unobserved.length}</td>
                    <td><button type="button" className="underline" onClick={() => explain(r)}>why?</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <h2 className="font-semibold mb-1">Retail risk table</h2>
              <p className="text-xs text-slate-400 mb-2">{out.retail_table.disclaimer}</p>
              <table className="w-full text-sm border-collapse"><tbody>
                {out.retail_table.rows.map((row) => (<tr key={row.key} className="border-t border-white/10"><td>{row.label}</td><td className={TONE[row.status] || ''}>{row.status}</td></tr>))}
              </tbody></table>
            </div>
          </div>
        )}
        {evidence && (
          <div className="border border-cyan-300/25 rounded p-3 text-sm">
            <h2 className="font-semibold">Evidence path (ledger chain valid: {String(evidence.chain_valid)})</h2>
            <ol className="list-decimal ml-5 mt-1">{evidence.path.map((n) => (<li key={n.id}><b>{n.kind}</b> <code className="text-xs">{n.hash.slice(0, 12)}</code></li>))}</ol>
          </div>
        )}
      </div>
    </div>
  );
}
