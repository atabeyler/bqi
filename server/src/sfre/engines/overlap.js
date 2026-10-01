import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { sum } from '../core/stats.js';

const ENGINE = 'overlap';

/**
 * funds: [{id, weights: Map|object asset -> w (null = unobserved)}]
 * dtl: object asset -> days-to-liquidate (optional, for liquidity-weighted overlap; null = unobserved)
 * Pairwise weighted overlap O_ij = sum_k min(w_ik, w_jk), cosine, liquidity-weighted overlap.
 */
export function pairOverlap(a, b, phi = null) {
  let o = 0; let lwo = 0; let dot = 0; let na = 0; let nb = 0; let excluded = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const wa = a[k]; const wb = b[k];
    // an asset unobserved (null) in either fund is excluded -> result becomes a lower bound
    if (wa === null || wb === null) { excluded++; continue; }
    const x = wa ?? 0; const y = wb ?? 0; // absent key == not held (observed zero), distinct from null
    const m = Math.min(x, y);
    o += m;
    if (phi) { const f = phi[k]; if (f !== null && f !== undefined) lwo += m * f; }
    dot += x * y; na += x * x; nb += y * y;
  }
  return { overlap: o, liquidityWeighted: phi ? lwo : null, cosine: na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0, excludedAssets: excluded };
}

/** empirical CDF rank of DTL across universe: phi_k in (0,1]; parameter-free. */
export function liquidityRankWeights(dtl) {
  const entries = Object.entries(dtl).filter(([, v]) => Number.isFinite(v));
  const sorted = entries.map(([, v]) => v).sort((x, y) => x - y);
  const phi = {};
  for (const [k, v] of entries) {
    let cnt = 0; while (cnt < sorted.length && sorted[cnt] <= v) cnt++;
    phi[k] = cnt / sorted.length;
  }
  for (const k of Object.keys(dtl)) if (!(k in phi)) phi[k] = null;
  return phi;
}

export function overlapMatrix(funds, dtl = null) {
  if (!Array.isArray(funds) || funds.length < 2) return failed(ENGINE, 'M03.overlap', 'at least two funds required');
  for (const f of funds) for (const [k, w] of Object.entries(f.weights)) if (w !== null && (!Number.isFinite(w) || w < 0)) return failed(ENGINE, 'M03.overlap', `invalid weight ${f.id}:${k}`);
  const phi = dtl ? liquidityRankWeights(dtl) : null;
  const n = funds.length;
  const O = Array.from({ length: n }, () => new Array(n).fill(0));
  const L = phi ? Array.from({ length: n }, () => new Array(n).fill(0)) : null;
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  let excludedTotal = 0;
  const unobserved = [];
  for (let i = 0; i < n; i++) {
    for (const [k, w] of Object.entries(funds[i].weights)) if (w === null) unobserved.push(`weight:${funds[i].id}:${k}`);
    for (let j = i; j < n; j++) {
      const r = pairOverlap(funds[i].weights, funds[j].weights, phi);
      O[i][j] = O[j][i] = i === j ? sum(Object.values(funds[i].weights).filter((x) => x !== null)) : r.overlap;
      C[i][j] = C[j][i] = i === j ? 1 : r.cosine;
      if (L) L[i][j] = L[j][i] = i === j ? r.liquidityWeighted : r.liquidityWeighted;
      if (i !== j) excludedTotal += r.excludedAssets;
    }
  }
  const lowerBound = excludedTotal > 0;
  return makeResult({
    engine: ENGINE, modelId: 'M03.overlap', status: lowerBound ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: { ids: funds.map((f) => f.id), overlap: O, cosine: C, liquidityWeighted: L, isLowerBound: lowerBound },
    coverage: coverageOf(1, 1), unobserved: [...new Set(unobserved)], calibration: CALIBRATION.UNCALIBRATED, parameters: { liquidityWeight: dtl ? 'empirical-CDF(DTL)' : 'none' },
    notes: lowerBound ? ['some weights unobserved: overlaps are lower bounds'] : [],
  });
}
