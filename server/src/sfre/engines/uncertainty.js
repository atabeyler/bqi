import { betaQuantile, quantile } from '../core/stats.js';

/** Percentile bootstrap CI for statistic(data). Seeded via the supplied Rng. */
export function bootstrapCI(data, statistic, rng, { B = 500, alpha = 0.05 } = {}) {
  const n = data.length;
  if (n < 2) return null;
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = data[rng.int(n)];
    const s = statistic(sample);
    if (Number.isFinite(s)) stats.push(s);
  }
  if (!stats.length) return null;
  return { lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2), B: stats.length, alpha };
}

/** Beta-Binomial credible interval for a rate k/n with Jeffreys prior Beta(1/2,1/2). */
export function rateInterval(k, n, { alpha = 0.05 } = {}) {
  if (!(n > 0)) return { k, n, point: null, lo: null, hi: null, ruleOfThreeUpper: null, note: 'n=0: rate UNOBSERVED' };
  const a = k + 0.5; const b = n - k + 0.5;
  return {
    k, n, point: k / n,
    lo: k === 0 ? 0 : betaQuantile(alpha / 2, a, b),
    hi: k === n ? 1 : betaQuantile(1 - alpha / 2, a, b),
    posteriorMean: a / (a + b),
    ruleOfThreeUpper: k === 0 ? Math.min(1, 3 / n) : null,
  };
}
