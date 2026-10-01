import React from 'react';

// Accessible, dependency-free charts. Every chart exposes its numbers as text (legend / sr-only table) so nothing
// is conveyed by colour alone, and uses logical CSS properties so it mirrors correctly in RTL (Arabic).

export const PALETTE = { direct: '#f59e0b', selfImpact: '#38bdf8', commonAsset: '#a78bfa', counterparty: '#f472b6', liquidity: '#38bdf8', redemption: '#34d399', margin: '#fb7185' };

const fmt = (n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);

/** One horizontal stacked bar with a legend that lists every segment's value and share. */
export function StackedBar({ title, segments, total, tableLabel }) {
  const shown = segments.filter((s) => s.value > 0);
  const sum = total > 0 ? total : shown.reduce((a, s) => a + s.value, 0);
  const label = `${title}: ${segments.map((s) => `${s.label} ${fmt(s.value)}`).join(', ')}`;
  return (
    <figure className="m-0">
      <figcaption className="text-sm font-medium mb-1">{title}</figcaption>
      <div role="img" aria-label={label} className="flex h-6 w-full overflow-hidden rounded bg-white/10">
        {shown.map((s) => (<div key={s.key} style={{ width: `${(s.value / sum) * 100}%`, background: s.color }} title={`${s.label}: ${fmt(s.value)}`} />))}
      </div>
      <ul className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 list-none p-0 m-0">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1">{s.label}</span>
            <span className="tabular-nums">{fmt(s.value)}{sum > 0 ? ` (${((s.value / sum) * 100).toFixed(1)}%)` : ''}</span>
          </li>
        ))}
      </ul>
      <table className="sr-only"><caption>{tableLabel}</caption><tbody>{segments.map((s) => (<tr key={s.key}><th scope="row">{s.label}</th><td>{fmt(s.value)}</td></tr>))}</tbody></table>
    </figure>
  );
}

/** Forced sales per cascade round as bars, with the round's mark-to-market loss as a line. */
export function RoundsChart({ title, rounds, salesLabel, lossLabel, roundLabel, tableLabel }) {
  const W = 560; const H = 180; const pad = { l: 8, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...rounds.map((r) => Math.max(r.sales, r.loss)));
  const n = Math.max(1, rounds.length); const bw = (W - pad.l - pad.r) / n;
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const pts = rounds.map((r, i) => `${pad.l + bw * i + bw / 2},${y(r.loss)}`).join(' ');
  return (
    <figure className="m-0">
      <figcaption className="text-sm font-medium mb-1">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${rounds.map((r) => `${roundLabel} ${r.round}: ${fmt(r.sales)}`).join('; ')}`} className="w-full h-auto max-h-56" preserveAspectRatio="xMidYMid meet">
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="currentColor" strokeOpacity="0.3" />
        {rounds.map((r, i) => (<rect key={r.round} x={pad.l + bw * i + bw * 0.15} y={y(r.sales)} width={bw * 0.7} height={Math.max(0, H - pad.b - y(r.sales))} fill="#38bdf8" rx="2"><title>{`${roundLabel} ${r.round}: ${fmt(r.sales)}`}</title></rect>))}
        {rounds.length > 1 && <polyline points={pts} fill="none" stroke="#fb7185" strokeWidth="2" />}
        {rounds.map((r, i) => (<circle key={`c${r.round}`} cx={pad.l + bw * i + bw / 2} cy={y(r.loss)} r="3" fill="#fb7185"><title>{`${roundLabel} ${r.round}: ${lossLabel} ${fmt(r.loss)}`}</title></circle>))}
        {rounds.map((r, i) => (<text key={`t${r.round}`} x={pad.l + bw * i + bw / 2} y={H - 10} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.7">{r.round}</text>))}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs mt-1">
        <span className="flex items-center gap-2"><span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ background: '#38bdf8' }} />{salesLabel}</span>
        <span className="flex items-center gap-2"><span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ background: '#fb7185' }} />{lossLabel}</span>
      </div>
      <table className="sr-only"><caption>{tableLabel}</caption><thead><tr><th>{roundLabel}</th><th>{salesLabel}</th><th>{lossLabel}</th></tr></thead><tbody>{rounds.map((r) => (<tr key={r.round}><td>{r.round}</td><td>{fmt(r.sales)}</td><td>{fmt(r.loss)}</td></tr>))}</tbody></table>
    </figure>
  );
}
