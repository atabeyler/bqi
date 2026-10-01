/** Numerical helpers. Pure functions; arrays of finite numbers unless stated. */

export const finite = (x) => typeof x === 'number' && Number.isFinite(x);

export function sum(a) { let s = 0; for (const x of a) s += x; return s; }
export function mean(a) { return a.length ? sum(a) / a.length : NaN; }

export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (a) => quantile(a, 0.5);

export function variance(a, ddof = 1) {
  if (a.length <= ddof) return NaN;
  const m = mean(a);
  let s = 0;
  for (const x of a) s += (x - m) ** 2;
  return s / (a.length - ddof);
}
export const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));

export function mad(a) {
  const m = median(a);
  return median(a.map((x) => Math.abs(x - m)));
}

/** robust scale: 1.4826*MAD; falls back to mean-absolute-deviation*1.2533 if MAD==0 */
export function robustScale(a) {
  const s = 1.4826 * mad(a);
  if (s > 0) return s;
  const m = median(a);
  const meanAbs = mean(a.map((x) => Math.abs(x - m)));
  return meanAbs > 0 ? 1.2533 * meanAbs : 0;
}

/** robust z of x against reference; NaN when reference is degenerate (zero spread) */
export function robustZ(x, ref) {
  const s = robustScale(ref);
  if (!(s > 0)) return NaN;
  return (x - median(ref)) / s;
}

export function covariance(x, y) {
  if (x.length !== y.length || x.length < 2) return NaN;
  const mx = mean(x); const my = mean(y);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (x.length - 1);
}

/** simple OLS y = a + b x. Returns null if degenerate. */
export function ols(x, y) {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const vx = variance(x);
  const mx = mean(x);
  if (!(vx > 1e-14 * (mx * mx + 1e-12))) return null; // relative tolerance: constant series have rounding-noise variance, not zero
  const b = covariance(x, y) / vx;
  const a = mean(y) - b * mean(x);
  let sse = 0; let sst = 0; const my = mean(y);
  for (let i = 0; i < n; i++) { sse += (y[i] - a - b * x[i]) ** 2; sst += (y[i] - my) ** 2; }
  const s2 = sse / (n - 2);
  const seB = Math.sqrt(s2 / (vx * (n - 1)));
  return { a, b, n, residualStd: Math.sqrt(s2), seB, r2: sst > 0 ? 1 - sse / sst : 0 };
}

export function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    if (!(prices[i] > 0) || !(prices[i - 1] > 0)) { out.push(NaN); continue; }
    out.push(Math.log(prices[i] / prices[i - 1]));
  }
  return out;
}

/** covariance matrix of columns (rows = observations). */
export function covMatrix(rows) {
  const n = rows.length; const k = rows[0].length;
  const means = Array.from({ length: k }, (_, j) => mean(rows.map((r) => r[j])));
  const C = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of rows) for (let i = 0; i < k; i++) for (let j = i; j < k; j++) C[i][j] += (r[i] - means[i]) * (r[j] - means[j]);
  for (let i = 0; i < k; i++) for (let j = i; j < k; j++) { C[i][j] /= (n - 1); C[j][i] = C[i][j]; }
  return C;
}

/** Cholesky A = L L'. Returns null if not positive definite. */
export function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 1e-18)) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

/** solve L y = b (lower) */
export function solveLower(L, b) {
  const n = L.length; const y = new Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  return y;
}

/** x' Σ^-1 x via Cholesky of Σ: |L^-1 x|^2 */
export function mahalanobisSq(x, L) {
  const y = solveLower(L, x);
  return sum(y.map((v) => v * v));
}

export function normalCdf(x) {
  // Abramowitz–Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Poisson upper tail P(X >= k | lambda), exact summation (stable for moderate k). */
export function poissonSf(k, lambda) {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let term = Math.exp(-lambda); let cdf = term;
  for (let i = 1; i < k; i++) { term *= lambda / i; cdf += term; }
  return Math.max(0, 1 - cdf);
}

export function lgamma(x) {
  // Lanczos approximation (g=7, n=9), accurate to ~1e-15 for x>0
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const xm = x - 1;
  let a = c[0];
  const t = xm + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/** regularized incomplete beta I_x(a,b), continued fraction (Numerical Recipes) */
export function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx, aa, bb) => {
    const FPMIN = 1e-300; let qab = aa + bb; let qap = aa + 1; let qam = aa - 1;
    let c = 1; let d = 1 - qab * xx / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aaa = m * (bb - m) * xx / ((qam + m2) * (aa + m2));
      d = 1 + aaa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aaa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
      aaa = -(aa + m) * (qab + m) * xx / ((aa + m2) * (qap + m2));
      d = 1 + aaa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aaa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? bt * cf(x, a, b) / a : 1 - bt * cf(1 - x, b, a) / b;
}

/** quantile of Beta(a,b) by bisection on betaInc */
export function betaQuantile(p, a, b) {
  let lo = 0; let hi = 1;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (betaInc(mid, a, b) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
