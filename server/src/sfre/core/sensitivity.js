import { Rng } from './prng.js';
import { quantile } from './stats.js';

export const DEFAULT_REL_WIDTH = 0.2;
export const MAX_BAND_SAMPLES = 200; // request-controlled `n` is clamped (CPU budget)

/**
 * Seeded Latin-hypercube sampling of ASSUMED model parameters. Produces an uncertainty block for scenario engines.
 * This is a *sensitivity band conditional on the stated parameter ranges*, NOT a statistical confidence interval of
 * real-world outcomes (no calibration data exists for these parameters).
 *  evaluate(paramsObject) -> finite scalar | null
 *  keys: parameter names (numeric) to perturb; ranges: {key:[lo,hi]} overrides, otherwise +-relWidth around params[key].
 */
export function parameterBand({ evaluate, params, keys, ranges = {}, relWidth = DEFAULT_REL_WIDTH, n: nIn = 48, seed = 1, label = 'band' }) {
  const n = Math.max(1, Math.min(MAX_BAND_SAMPLES, Math.floor(Number.isFinite(nIn) ? nIn : 48)));
  const rng = new Rng(seed).child(`sens:${label}`);
  const active = keys.filter((k) => Number.isFinite(params[k]));
  const rng_ = Object.fromEntries(active.map((k) => {
    const r = ranges[k]; if (r) return [k, [Math.min(r[0], r[1]), Math.max(r[0], r[1])]];
    const v = params[k]; const w = Math.abs(v) * relWidth; return [k, [v - w, v + w]];
  }));
  const base = evaluate(params);
  if (!active.length) return { method: 'NONE', reason: 'no numeric assumptions to perturb', n: 0, base };
  const perm = active.map(() => rng.shuffle(Array.from({ length: n }, (_, i) => i)));
  const vals = [];
  for (let i = 0; i < n; i++) {
    const p = { ...params };
    active.forEach((k, j) => { const [lo, hi] = rng_[k]; p[k] = lo + (hi - lo) * ((perm[j][i] + rng.next()) / n); });
    const v = evaluate(p);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { method: 'LATIN_HYPERCUBE_ASSUMPTION_BAND', n: 0, base, note: 'no valid evaluations' };
  return {
    method: 'LATIN_HYPERCUBE_ASSUMPTION_BAND', n: vals.length, seed, base, relWidth, ranges: rng_,
    p05: quantile(vals, 0.05), p50: quantile(vals, 0.5), p95: quantile(vals, 0.95), min: Math.min(...vals), max: Math.max(...vals),
    note: 'sensitivity of the headline metric to the stated assumption ranges; not a confidence interval for real-world outcomes',
  };
}
