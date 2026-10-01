import { hashOf } from '../core/canonical.js';
import { assertNoFutureData } from '../data/pitStore.js';
import { quantile } from '../core/stats.js';
import { prAuc } from './metrics.js';

/** Fold generator. purge removes training samples whose label window (horizon) overlaps the test start. */
export function makeFolds({ n, initialTrain, testSize, step = testSize, mode = 'expanding', window = null, purge = 0 }) {
  const folds = [];
  for (let start = initialTrain; start + testSize <= n; start += step) {
    const trainEnd = start - purge;
    const trainStart = mode === 'rolling' ? Math.max(0, trainEnd - (window ?? initialTrain)) : 0;
    if (trainEnd - trainStart <= 0) continue;
    folds.push({ trainIdx: range(trainStart, trainEnd), testIdx: range(start, start + testSize) });
  }
  return folds;
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/**
 * Walk-forward evaluation. For each fold: fit(trainTimes) -> model; for every test time T:
 *   view = store.asOf(T); assertNoFutureData(view, T); score(model, view, T).
 * No test-fold information can reach fit(); the firewall is asserted before every score call.
 */
export function walkForward({ store, times, folds, fit, score }) {
  const out = [];
  for (const f of folds) {
    const trainTimes = f.trainIdx.map((i) => times[i]);
    const maxTrain = Math.max(...trainTimes); const minTest = Math.min(...f.testIdx.map((i) => times[i]));
    if (maxTrain >= minTest) throw new Error('walkForward: training times overlap test times');
    const model = fit(trainTimes);
    const scored = [];
    for (const i of f.testIdx) { const T = times[i]; const view = store.asOf(T); assertNoFutureData(view, T); scored.push({ t: T, scores: score(model, view, T) }); }
    out.push({ trainEnd: maxTrain, testStart: minTest, model, scored });
  }
  return out;
}

export class HoldoutBurnedError extends Error { constructor() { super('HOLDOUT_BURNED: locked holdout was already evaluated once'); this.name = 'HoldoutBurnedError'; } }

/** Locked holdout: declare once, evaluate exactly once. A second evaluation burns it (it would be used for tuning). */
export class LockedHoldout {
  #used = 0; #ids;
  constructor({ ids, periodStart, periodEnd }) { this.#ids = Object.freeze(ids.slice()); this.lock_hash = hashOf({ ids: this.#ids, periodStart, periodEnd }); this.periodStart = periodStart; this.periodEnd = periodEnd; }
  get accessCount() { return this.#used; }
  get burned() { return this.#used > 1; }
  evaluate(fn) {
    if (this.#used >= 1) { this.#used++; throw new HoldoutBurnedError(); }
    this.#used++;
    return { lock_hash: this.lock_hash, result: fn(this.#ids) };
  }
}

/** Label-permutation negative control for PR-AUC; returns permutation p-value and the null distribution summary. */
export function permutationControl({ labels, scores, rng, B = 500 }) {
  const obs = prAuc(labels, scores); const base = labels.filter(Boolean).length / labels.length;
  const nulls = [];
  for (let b = 0; b < B; b++) nulls.push(prAuc(rng.shuffle(labels), scores));
  const ge = nulls.filter((x) => x >= obs).length;
  return { observedPrAuc: obs, baseRate: base, nullMean: nulls.reduce((s, x) => s + x, 0) / B, null95: quantile(nulls, 0.95), pValue: (1 + ge) / (B + 1), passed: obs > quantile(nulls, 0.95) };
}

/** Ablation: runFn(disabledSet) -> metrics object; returns deltas vs the full model. */
export function ablation(components, runFn) {
  const full = runFn(new Set());
  const rows = components.map((c) => { const m = runFn(new Set([c])); return { removed: c, metrics: m, delta: Object.fromEntries(Object.keys(full).filter((k) => typeof full[k] === 'number').map((k) => [k, m[k] - full[k]])) }; });
  return { full, rows };
}

/** Parameter perturbation: multiplies each parameter by (1 +/- f) one at a time. runFn(params) -> metrics. */
export function sensitivity(baseParams, runFn, factors = [-0.5, -0.2, 0.2, 0.5]) {
  const base = runFn(baseParams); const rows = [];
  for (const k of Object.keys(baseParams)) {
    const runs = factors.map((f) => ({ factor: f, metrics: runFn({ ...baseParams, [k]: baseParams[k] * (1 + f) }) }));
    const metricKeys = Object.keys(base).filter((m) => typeof base[m] === 'number');
    rows.push({ parameter: k, ranges: Object.fromEntries(metricKeys.map((m) => { const vals = [base[m], ...runs.map((r) => r.metrics[m])]; return [m, { min: Math.min(...vals), max: Math.max(...vals) }]; })) });
  }
  return { base, rows };
}

/** Metrics per regime label. evaluate(subsetOfSamples) -> metrics. samples: [{regime, ...}] */
export function regimeRobustness(samples, evaluate) {
  const groups = new Map();
  for (const s of samples) { if (!groups.has(s.regime)) groups.set(s.regime, []); groups.get(s.regime).push(s); }
  const rows = [...groups.entries()].map(([regime, list]) => ({ regime, n: list.length, metrics: evaluate(list) }));
  return { rows, worstRecall: rows.length ? Math.min(...rows.map((r) => r.metrics.recall ?? 0)) : null };
}

/** Champion/challenger on identical folds. Advisory only: promotion happens exclusively through governance. */
export function championChallenger({ championPerFold, challengerPerFold, metric = 'prAuc', fprKey = 'fpr', fprTolerance = 0.005, rng, B = 1000 }) {
  const d = championPerFold.map((c, i) => challengerPerFold[i][metric] - c[metric]);
  const boots = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[rng.int(d.length)]; boots.push(s / d.length); }
  const lo = quantile(boots, 0.025); const hi = quantile(boots, 0.975);
  const fprDelta = challengerPerFold.reduce((s, x) => s + x[fprKey], 0) / d.length - championPerFold.reduce((s, x) => s + x[fprKey], 0) / d.length;
  const better = lo > 0 && fprDelta <= fprTolerance;
  return { metric, meanDelta: d.reduce((s, x) => s + x, 0) / d.length, ci95: { lo, hi }, fprDelta, verdict: better ? 'CHALLENGER_BETTER_ADVISORY' : 'CHAMPION_RETAINED', note: 'advisory only; no automatic promotion' };
}
