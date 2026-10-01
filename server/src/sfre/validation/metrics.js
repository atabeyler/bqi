import { precisionRecallAuc } from '../../benchmarks/benchmarkMetrics.js';
import { rateInterval } from '../engines/uncertainty.js';

/** Confusion-based metrics with Beta-Binomial (Jeffreys) intervals. labels: boolean[], alarms: boolean[] */
export function classificationMetrics(labels, alarms) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  labels.forEach((y, i) => { const a = alarms[i]; if (y && a) tp++; else if (!y && a) fp++; else if (!y && !a) tn++; else fn++; });
  const precision = rateInterval(tp, tp + fp); const recall = rateInterval(tp, tp + fn);
  const fpr = rateInterval(fp, fp + tn); const fnr = rateInterval(fn, fn + tp);
  return { tp, fp, tn, fn, precision, recall, fpr, fnr, positives: tp + fn, negatives: fp + tn, baseRate: labels.length ? (tp + fn) / labels.length : null };
}

/** PR-AUC via the repo's existing, tested implementation (benchmarks/benchmarkMetrics.js). */
export function prAuc(labels, scores) {
  return precisionRecallAuc(labels.map((y) => (y ? 'illicit' : 'licit')), scores);
}

export function brier(probs, labels) {
  if (!probs.length) return null;
  return probs.reduce((s, p, i) => s + (p - (labels[i] ? 1 : 0)) ** 2, 0) / probs.length;
}

/** Expected calibration error with equal-mass bins. */
export function ece(probs, labels, bins = 10) {
  const n = probs.length; if (!n) return null;
  const idx = probs.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor((b * n) / bins); const hi = Math.floor(((b + 1) * n) / bins);
    if (hi <= lo) continue;
    let sp = 0; let sy = 0;
    for (let k = lo; k < hi; k++) { sp += idx[k][0]; sy += labels[idx[k][1]] ? 1 : 0; }
    total += (hi - lo) * Math.abs(sp / (hi - lo) - sy / (hi - lo));
  }
  return total / n;
}

/**
 * Lead time per event: event_time - first alarm within [event_time - horizon, event_time).
 * alarmsByEntity: {entity: [{t, alarm}]}; events: [{entity, event_time}] (ms). Missed event => lead null.
 */
export function leadTimes(events, alarmsByEntity, horizonMs) {
  return events.map((e) => {
    const series = (alarmsByEntity[e.entity] || []).filter((x) => x.alarm && x.t >= e.event_time - horizonMs && x.t < e.event_time).sort((a, b) => a.t - b.t);
    return { entity: e.entity, event_time: e.event_time, firstAlarm: series.length ? series[0].t : null, leadMs: series.length ? e.event_time - series[0].t : null };
  });
}

/** Alarm stability = fraction of consecutive evaluations whose alarm state flips (lower is more stable). */
export function alarmStability(alarmsByEntity) {
  let flips = 0; let transitions = 0;
  for (const series of Object.values(alarmsByEntity)) {
    const s = series.slice().sort((a, b) => a.t - b.t);
    for (let i = 1; i < s.length; i++) { transitions++; if (s[i].alarm !== s[i - 1].alarm) flips++; }
  }
  return { flips, transitions, flipRate: transitions ? flips / transitions : null };
}

/** 1-D logistic regression (Newton, L2-regularised by 1e-6) turning a score into a probability; fitted on TRAIN only. */
export function fitLogistic(scores, labels) {
  const mu = scores.reduce((s, x) => s + x, 0) / scores.length; const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mu) ** 2, 0) / scores.length) || 1;
  let a = 0; let b = 0;
  for (let it = 0; it < 50; it++) {
    let g0 = 0; let g1 = 0; let h00 = 1e-6; let h01 = 0; let h11 = 1e-6;
    scores.forEach((s, i) => { const x = (s - mu) / sd; const p = 1 / (1 + Math.exp(-(a + b * x))); const y = labels[i] ? 1 : 0; const w = p * (1 - p) + 1e-9; g0 += p - y; g1 += (p - y) * x; h00 += w; h01 += w * x; h11 += w * x * x; });
    const det = h00 * h11 - h01 * h01; if (!(Math.abs(det) > 1e-18)) break;
    const da = (h11 * g0 - h01 * g1) / det; const db = (-h01 * g0 + h00 * g1) / det;
    a -= da; b -= db; if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { predict: (s) => 1 / (1 + Math.exp(-(a + b * ((s - mu) / sd)))), a, b, mu, sd };
}

/** Threshold on train negatives so that train FPR is <= target (empirical quantile). */
export function thresholdForFpr(scores, labels, targetFpr) {
  const neg = scores.filter((_, i) => !labels[i]).sort((x, y) => x - y);
  if (!neg.length) return Infinity;
  const k = Math.min(neg.length - 1, Math.max(0, Math.ceil((1 - targetFpr) * neg.length) - 1));
  return neg[k];
}
