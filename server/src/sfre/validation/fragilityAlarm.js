import { runCascade } from '../engines/cascade.js';
import { amihud } from '../engines/microstructure.js';
import { logReturns, median, finite } from '../core/stats.js';
import { robustZDetector, ewmaDetector, cusumDetector, changePointDetector } from '../engines/anomaly/detectors.js';
import { assertNoFutureData } from '../data/pitStore.js';

const DAY = 86400000;
export const STANDARD_STRESS = Object.freeze({ redemptionFraction: 0.03, impactModel: { model: 'amihud-linear' } }); // convention; UNCALIBRATED

function lastN(series, n) { return series.slice(-n); }

/** Builds a FundSystem strictly from a PIT view (no raw store). Unobserved leverage/margin/beta stay null. */
export function systemFromView(view, assetIds, fundIds) {
  const assets = [];
  for (const id of assetIds) {
    const close = lastN(view.series(id, 'close').map((x) => x.value), 61); const vol = lastN(view.series(id, 'volume').map((x) => x.value), 61);
    if (!close.length) continue;
    let illiq = null;
    if (close.length >= 30 && vol.length === close.length) { const r = amihud({ returns: logReturns(close), prices: close, volumes: vol }); if (r.value) illiq = r.value.illiq; }
    assets.push({ id, price: close[close.length - 1], illiq, adv: vol.length ? median(vol.filter(finite)) : null });
  }
  const aIdx = new Map(assets.map((a, k) => [a.id, k]));
  const funds = [];
  for (const id of fundIds) {
    const h = view.latest(id, 'holdings'); const aum = view.latest(id, 'aum'); const cash = view.latest(id, 'cash_ratio'); const debt = view.latest(id, 'debt_ratio');
    if (!h || !aum || !cash) continue; // fund not yet reported at this T
    const holdings = [];
    for (const tok of String(h.value).split(',')) { const [ai, w] = tok.split(':'); const a = assets[aIdx.get(assetIds[Number(ai)])]; if (a) holdings.push({ asset: a.id, shares: (Number(w) * aum.value) / a.price }); }
    funds.push({ id, cash: cash.value * aum.value, debt: debt && debt.value !== null ? debt.value * aum.value : null, marginRatio: null, beta: null, holdings });
  }
  return { assets, funds, impact: STANDARD_STRESS.impactModel };
}

/** Fragility = cascade loss fraction of each fund under a fixed standardized redemption stress. */
export function fragilityScores(view, assetIds, fundIds) {
  const system = systemFromView(view, assetIds, fundIds);
  const redemptions = Object.fromEntries(system.funds.map((f) => [f.id, { fraction: STANDARD_STRESS.redemptionFraction }]));
  const res = runCascade(system, { priceShocks: {}, redemptions });
  const out = {};
  if (res.value) for (const f of res.value.funds) out[f.id] = f.nav0 > 0 ? f.loss / f.nav0 : null;
  return { scores: out, unobserved: res.unobserved?.length ?? 0, status: res.status };
}

/** Cheap-detector flow signal count (0..4) on the fund's weekly net flow series; reference strictly precedes evaluation. */
export function flowSignalCount(view, fundId, evalLen = 4, refLen = 40) {
  const s = view.series(fundId, 'net_flow_ratio').map((x) => x.value).filter(finite);
  if (s.length < evalLen + 32) return null; // UNOBSERVED: not enough history
  const ev = s.slice(-evalLen); const ref = s.slice(-(evalLen + refLen), -evalLen);
  return [robustZDetector, ewmaDetector, cusumDetector, changePointDetector].map((d) => d(ref, ev)).filter((m) => m.status === 'SIGNAL').length;
}

/** Feature extractor for validation. Asserts the firewall for every view it touches. */
export function makeFeatureExtractor(store, assetIds, fundIds) {
  const memo = new Map();
  const fragAt = (T) => {
    if (memo.has(T)) return memo.get(T);
    const view = store.asOf(T); assertNoFutureData(view, T);
    const r = fragilityScores(view, assetIds, fundIds);
    memo.set(T, r); return r;
  };
  return {
    featuresAt(T) {
      const view = store.asOf(T); assertNoFutureData(view, T);
      const now = fragAt(T).scores; const past = fragAt(T - 28 * DAY).scores;
      const out = {};
      for (const id of fundIds) {
        const frag = now[id]; const prev = past[id];
        if (frag === undefined || frag === null) continue;
        out[id] = { frag, dFrag: prev === undefined || prev === null ? null : frag - prev, flowSig: flowSignalCount(view, id) };
      }
      return out;
    },
  };
}
