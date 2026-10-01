import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { median, robustScale, finite } from '../core/stats.js';

const ENGINE = 'valuation';
export const MIN_PEERS = 5;
const MULTIPLES = ['ev_sales', 'ev_ebitda', 'pe', 'pb', 'p_fcf'];

/** Multiples from {market_cap, debt, cash, revenue, ebitda, net_income, equity, fcf}. Non-positive denominators => null ('NOT_MEANINGFUL'). */
export function multiples(x) {
  const ev = finite(x.market_cap) && finite(x.debt) && finite(x.cash) ? x.market_cap + x.debt - x.cash : null;
  const pos = (v) => finite(v) && v > 0;
  return {
    ev_sales: ev !== null && pos(x.revenue) ? ev / x.revenue : null,
    ev_ebitda: ev !== null && pos(x.ebitda) ? ev / x.ebitda : null,
    pe: finite(x.market_cap) && pos(x.net_income) ? x.market_cap / x.net_income : null,
    pb: finite(x.market_cap) && pos(x.equity) ? x.market_cap / x.equity : null,
    p_fcf: finite(x.market_cap) && pos(x.fcf) ? x.market_cap / x.fcf : null,
  };
}

/**
 * Peer-relative and own-history valuation DIVERGENCE (a measurement; never a "fair price").
 * target: inputs object; peers: array of inputs objects (PIT); history: array of past multiples-objects for the target.
 */
export function valuationDivergence({ target, peers = [], history = [] }) {
  const m = multiples(target);
  const rows = []; const unobserved = [];
  for (const name of MULTIPLES) {
    if (m[name] === null) { rows.push({ multiple: name, value: null, note: 'NOT_MEANINGFUL_OR_UNOBSERVED' }); unobserved.push(`multiple.${name}`); continue; }
    const peerVals = peers.map((p) => multiples(p)[name]).filter((v) => v !== null && v > 0).map(Math.log);
    let peerZ = null; let peerNote = null;
    if (peerVals.length >= MIN_PEERS) { const s = robustScale(peerVals); if (s > 0) peerZ = (Math.log(m[name]) - median(peerVals)) / s; else peerNote = 'peer spread is zero'; } else peerNote = `peers ${peerVals.length} < ${MIN_PEERS}`;
    const hist = history.map((h) => h[name]).filter((v) => v !== null && Number.isFinite(v));
    const histPct = hist.length >= 8 ? hist.filter((v) => v <= m[name]).length / hist.length : null;
    rows.push({ multiple: name, value: m[name], peerRobustZ: peerZ, peerCount: peerVals.length, historyPercentile: histPct, historyCount: hist.length, note: peerNote });
  }
  const measured = rows.filter((r) => r.peerRobustZ !== null || r.historyPercentile !== null).length;
  return makeResult({
    engine: ENGINE, modelId: 'M31.valuation', status: measured === 0 ? STATUS.INSUFFICIENT_DATA : unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: { rows }, coverage: coverageOf(rows.filter((r) => r.value !== null).length, MULTIPLES.length), unobserved,
    calibration: CALIBRATION.UNCALIBRATED, parameters: { minPeers: MIN_PEERS },
    notes: ['valuation divergence measurement only; SFRE never states a fair or "real" price'],
  });
}
