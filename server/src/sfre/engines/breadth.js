import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { finite } from '../core/stats.js';

const ENGINE = 'breadth';
export const BREADTH_PARAMS = Object.freeze({ zThreshold: 3, kSigma: 4, minUplift: 0.05, minFunds: 30, minRef: 26, scaleFloor: 0.005, source: 'cross-sectional breadth statistic; thresholds learned from the reference window, not textbook' });

const median = (a) => { const s = Float64Array.from(a).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/**
 * System-level "breadth" alarm: instead of asking whether ONE fund's flow is unusual (noisy, per-fund false alarms),
 * ask what share of funds is simultaneously far outside its OWN normal. A market-wide episode moves many funds at once,
 * which a single noisy fund cannot fake.
 *
 *  reference / evaluation: number[fund][week] with the same fund order (null/NaN = unobserved, never zero).
 *  direction: 'outflow' (z < -zThreshold), 'inflow' (z > +zThreshold) or 'both'.
 * Per-fund centre/scale (median / MAD, floored) come from the reference window only. The alarm level is
 * max(mean + kSigma*sd of the REFERENCE breadth, 2*mean, mean + minUplift), so it adapts to how correlated the funds normally are.
 * UNCALIBRATED: the level is a documented convention validated on one dataset, not a calibrated alarm rate.
 */
export function breadthAlarm({ reference, evaluation, direction = 'outflow', zThreshold = BREADTH_PARAMS.zThreshold, kSigma = BREADTH_PARAMS.kSigma, label = 'fund flows' }) {
  const P = BREADTH_PARAMS;
  const funds = Math.min(reference?.length ?? 0, evaluation?.length ?? 0);
  const refWeeks = reference?.[0]?.length ?? 0; const evWeeks = evaluation?.[0]?.length ?? 0;
  const insufficient = (why) => makeResult({ engine: ENGINE, modelId: 'M21.breadth', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(0, 1), unobserved: ['reference/evaluation matrices'], parameters: { ...P, zThreshold, kSigma, direction }, notes: [why] });
  if (funds < P.minFunds) return insufficient(`need at least ${P.minFunds} funds, got ${funds}`);
  if (refWeeks < P.minRef) return insufficient(`need at least ${P.minRef} reference weeks, got ${refWeeks}`);
  if (evWeeks < 1) return insufficient('empty evaluation window');

  const centre = []; const scale = [];
  for (let i = 0; i < funds; i++) {
    const r = reference[i].filter(finite);
    if (r.length < P.minRef) { centre.push(null); scale.push(null); continue; }
    const m = median(r); const mad = median(r.map((x) => Math.abs(x - m))) * 1.4826;
    centre.push(m); scale.push(Math.max(mad, P.scaleFloor));
  }
  const usable = centre.map((c, i) => (c === null ? -1 : i)).filter((i) => i >= 0);
  if (usable.length < P.minFunds) return insufficient(`only ${usable.length} funds have enough reference history`);
  const hit = (x, i) => { const z = (x - centre[i]) / scale[i]; return direction === 'inflow' ? z > zThreshold : direction === 'both' ? Math.abs(z) > zThreshold : z < -zThreshold; };
  const breadthAt = (mat, t) => { let n = 0; let h = 0; for (const i of usable) { const x = mat[i][t]; if (!finite(x)) continue; n++; if (hit(x, i)) h++; } return n >= P.minFunds ? { b: h / n, n, h } : null; };

  const refB = []; for (let t = 0; t < refWeeks; t++) { const r = breadthAt(reference, t); if (r) refB.push(r.b); }
  if (refB.length < P.minRef) return insufficient('too few reference weeks with enough observed funds');
  const base = mean(refB); const spread = sd(refB);
  const level = Math.max(base + kSigma * spread, 2 * base, base + P.minUplift);

  const weeks = []; for (let t = 0; t < evWeeks; t++) { const r = breadthAt(evaluation, t); weeks.push(r ? { index: t, breadth: r.b, funds: r.n, flagged: r.b > level } : { index: t, breadth: null, funds: 0, flagged: false }); }
  const observed = weeks.filter((w) => w.breadth !== null);
  const status = observed.length === 0 ? STATUS.INSUFFICIENT_DATA : observed.some((w) => w.flagged) ? STATUS.SIGNAL : STATUS.NO_SIGNAL;
  return makeResult({
    engine: ENGINE, modelId: 'M21.breadth', status,
    value: { label, direction, fundsUsed: usable.length, baseline: { meanBreadth: base, sdBreadth: spread }, alarmLevel: level, weeks, flaggedWeeks: observed.filter((w) => w.flagged).map((w) => w.index) },
    uncertainty: { referenceWeeks: refB.length, baselineSd: spread },
    coverage: coverageOf(observed.length, weeks.length), unobserved: weeks.filter((w) => w.breadth === null).map((w) => `week:${w.index}`),
    calibration: CALIBRATION.UNCALIBRATED, parameters: { ...P, zThreshold, kSigma, direction },
    notes: ['NO_SIGNAL is not safety; the alarm level is learned from the reference window and assumes that window was calm', 'a high breadth says many funds left together, not why'],
  });
}
