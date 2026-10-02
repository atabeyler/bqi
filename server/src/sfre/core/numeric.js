/**
 * High-accuracy normal distribution helpers (vNext engines). core/stats.js `normalCdf` (A&S 7.1.26, ~1.5e-7)
 * is left untouched for existing engines; these are accurate to ~1e-15 and are cross-checked against Python's
 * statistics.NormalDist in tests.
 */
const SQRT_PI = Math.sqrt(Math.PI);

/** erfc for x >= 0: non-alternating series for small x, continued fraction for large x. */
function erfcPos(x) {
  if (x < 2.5) {
    // erf(x) = 2/sqrt(pi) * exp(-x^2) * sum_{n>=0} 2^n x^(2n+1) / (2n+1)!!
    let term = x; let s = x;
    for (let n = 1; n < 400; n++) { term *= (2 * x * x) / (2 * n + 1); s += term; if (term < 1e-17 * s) break; }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * s;
  }
  // erfc(x) = exp(-x^2)/(sqrt(pi)) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...))))
  let f = x;
  for (let k = 300; k >= 1; k--) f = x + (k / 2) / f;
  return Math.exp(-x * x) / (SQRT_PI * f);
}

export function erfc(x) { return x >= 0 ? erfcPos(x) : 2 - erfcPos(-x); }

export function normalCdfPrecise(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * erfc(-z / Math.SQRT2);
}

export function normalPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }

/** Inverse normal CDF: Acklam rational approximation + one Halley refinement (error ~1e-15). p in (0,1). */
export function normalInv(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normalInv: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425; let x;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else { const q = p - 0.5; const r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  const e = normalCdfPrecise(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/** Vasicek one-factor conditional PD given systematic factor g (g<0 = stress): Phi((Phi^-1(pd) - sqrt(rho) g)/sqrt(1-rho)). */
export function vasicekConditionalPd(pd, rho, g) {
  if (!(pd > 0 && pd < 1)) return pd <= 0 ? 0 : 1;
  return normalCdfPrecise((normalInv(pd) - Math.sqrt(rho) * g) / Math.sqrt(1 - rho));
}

/** PD stress through a probit shift: Phi(Phi^-1(pd) + shift). pd in [0,1]. */
export function probitShift(pd, shift) {
  if (pd <= 0) return 0;
  if (pd >= 1) return 1;
  return normalCdfPrecise(normalInv(pd) + shift);
}

/** Locale-independent string order (codepoint): `localeCompare` depends on the host locale and would make tie-breaks (hence hashes) machine-dependent. */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const isFrac = (x) => isNum(x) && x >= 0 && x <= 1;
export const isNonNeg = (x) => isNum(x) && x >= 0;
/** value is unobserved (explicit null/undefined) -- never silently 0 */
export const unobs = (x) => x === null || x === undefined;
