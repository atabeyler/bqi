import { binaryMetrics } from './benchmarkMetrics.js';
import { applyOrientation } from './thresholdSelection.js';

function knownPairs(labels, scores) {
  const out = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 'unknown') continue;
    const score = Number(scores[i]);
    if (Number.isFinite(score)) out.push({ label: labels[i], score });
  }
  return out;
}

/**
 * Select a threshold on validation data subject to a minimum illicit recall.
 * Fast path for minRecall=1: the highest feasible threshold is exactly the
 * minimum positive score, so there is no need to rescan every unique score.
 * Test labels must never be passed here.
 */
export function selectConstrainedThreshold(labels, scores, opts = {}) {
  const minRecall = opts.minRecall ?? 1;
  const orientations = opts.orientations ?? [1, -1];
  let best = null;

  for (const orientation of orientations) {
    const oriented = applyOrientation(scores, orientation);
    const pairs = knownPairs(labels, oriented);
    let thresholds;

    if (minRecall >= 1 - 1e-12) {
      let minPositive = Infinity;
      for (const pair of pairs) {
        if (pair.label === 'illicit' && pair.score < minPositive) minPositive = pair.score;
      }
      if (!Number.isFinite(minPositive)) continue;
      thresholds = [minPositive];
    } else {
      thresholds = [...new Set([0, 1, ...pairs.map((x) => x.score)])].sort((a, b) => a - b);
    }

    for (const threshold of thresholds) {
      const metrics = binaryMetrics(labels, oriented, threshold);
      if (!Number.isFinite(metrics.recall) || metrics.recall + 1e-12 < minRecall) continue;
      const candidate = { orientation, threshold, metrics };
      if (!best ||
          metrics.precision > best.metrics.precision + 1e-12 ||
          (Math.abs(metrics.precision - best.metrics.precision) <= 1e-12 && metrics.f1 > best.metrics.f1 + 1e-12) ||
          (Math.abs(metrics.precision - best.metrics.precision) <= 1e-12 && Math.abs(metrics.f1 - best.metrics.f1) <= 1e-12 && threshold > best.threshold)) {
        best = candidate;
      }
    }
  }

  if (!best) throw new Error(`no validation threshold satisfies minRecall=${minRecall}`);
  return best;
}
