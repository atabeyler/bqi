import { binaryMetrics } from './benchmarkMetrics.js';

/** Select threshold on validation data only. Never pass test labels here. */
export function selectThreshold(validationLabels, validationScores, opts = {}) {
  const objective = opts.objective || 'f1';
  const minRecall = opts.minRecall ?? 0;
  let best = null;
  for (let i = 1; i < 100; i++) {
    const threshold = i / 100;
    const metrics = binaryMetrics(validationLabels, validationScores, threshold);
    if (metrics.recall < minRecall) continue;
    const value = Number(metrics[objective] ?? metrics.f1);
    if (!best || value > best.value || (value === best.value && threshold > best.threshold)) {
      best = { threshold, value, metrics };
    }
  }
  return best || { threshold: 0.5, value: 0, metrics: binaryMetrics(validationLabels, validationScores, 0.5) };
}

/**
 * Some scorers end up anti-correlated with the positive class on a given
 * dataset -- e.g. a marginal-outlier score can rank legitimate high-volume
 * accounts above illicit ones that deliberately look unremarkable. Rather
 * than hardcode a sign for a scorer, try both orientations here (score as-is
 * vs. 1-score) and let validation-only performance pick the winner. Test
 * labels are never touched -- the same discipline as selectThreshold.
 */
export function selectOrientationAndThreshold(validationLabels, validationScores, opts = {}) {
  const asIs = selectThreshold(validationLabels, validationScores, opts);
  const inverted = selectThreshold(validationLabels, validationScores.map((s) => 1 - s), opts);
  return inverted.value > asIs.value
    ? { orientation: -1, threshold: inverted.threshold, metrics: inverted.metrics }
    : { orientation: 1, threshold: asIs.threshold, metrics: asIs.metrics };
}

/** Applies an orientation chosen by selectOrientationAndThreshold to any score array. */
export function applyOrientation(scores, orientation) {
  return orientation === -1 ? scores.map((s) => 1 - s) : scores;
}
