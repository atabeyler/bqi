import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { median, robustScale, finite } from '../core/stats.js';

const ENGINE = 'divergence';
export const Z = 3.5;
export const MIN_PEERS = 5;

/**
 * Fundamental–price divergence over a window. Vector output, never a single ratio.
 *  target: {dLnMcap, dLnRevenue, dCfoOverAssets, dNetDebtOverAssets, dilution}  (null = UNOBSERVED)
 *  peers:  same shape (peer-adjustment baseline; need >= MIN_PEERS)
 *  marketReturn: index log-return over the same window (regime/market adjustment)
 */
export function fundamentalPriceDivergence({ target, peers, marketReturn }) {
  const dims = ['dLnMcap', 'dLnRevenue', 'dCfoOverAssets', 'dNetDebtOverAssets', 'dilution'];
  const unobserved = dims.filter((d) => !finite(target?.[d])).map((d) => `target.${d}`);
  if (!finite(marketReturn)) unobserved.push('marketReturn');
  const adj = {}; const zs = {}; const peerNotes = [];
  for (const d of dims) {
    if (!finite(target?.[d])) { adj[d] = null; zs[d] = null; continue; }
    const pv = (peers || []).map((p) => p[d]).filter(finite);
    if (pv.length < MIN_PEERS) { adj[d] = null; zs[d] = null; peerNotes.push(`${d}: peers ${pv.length} < ${MIN_PEERS}`); unobserved.push(`peers.${d}`); continue; }
    const base = median(pv); const s = robustScale(pv);
    adj[d] = target[d] - base - (d === 'dLnMcap' && finite(marketReturn) ? marketReturn : 0);
    zs[d] = s > 0 ? adj[d] / s : null;
  }
  const mcapZ = zs.dLnMcap;
  // supportive direction: revenue up, cfo up, net debt down, dilution not up
  const sup = {
    dLnRevenue: zs.dLnRevenue === null ? null : zs.dLnRevenue >= 0,
    dCfoOverAssets: zs.dCfoOverAssets === null ? null : zs.dCfoOverAssets >= 0,
    dNetDebtOverAssets: zs.dNetDebtOverAssets === null ? null : zs.dNetDebtOverAssets <= 0,
    dilution: zs.dilution === null ? null : zs.dilution <= 0,
  };
  const observedSup = Object.values(sup).filter((v) => v !== null);
  const notSupportive = observedSup.filter((v) => v === false).length;
  const value = { peerAdjusted: adj, robustZ: zs, supportive: sup, observedFundamentalDims: observedSup.length, notSupportiveCount: notSupportive };
  const coverage = coverageOf(dims.filter((d) => zs[d] !== null).length, dims.length);
  if (mcapZ === null || observedSup.length < 2) {
    return makeResult({ engine: ENGINE, modelId: 'M32.divergence', status: STATUS.INSUFFICIENT_OBSERVABILITY, value, coverage, unobserved, calibration: CALIBRATION.UNCALIBRATED, parameters: { z: Z, minPeers: MIN_PEERS }, notes: ['unobserved fundamentals are NOT counted as unsupportive', ...peerNotes] });
  }
  const suspected = mcapZ > Z && notSupportive >= 2;
  return makeResult({
    engine: ENGINE, modelId: 'M32.divergence', status: suspected ? STATUS.SIGNAL : STATUS.NO_SIGNAL,
    value: { ...value, label: suspected ? 'DIVERGENCE_SUSPECTED' : 'NO_DIVERGENCE_DETECTED' }, coverage, unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { z: Z, minPeers: MIN_PEERS, rule: 'mcap peer/market-adjusted z>3.5 AND >=2 observed fundamental dims not supportive' },
    notes: ['NO_SIGNAL is not safety', ...peerNotes],
  });
}
