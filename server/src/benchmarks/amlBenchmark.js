import { binaryMetrics } from './benchmarkMetrics.js';
import { revealEllipticLabels } from './ellipticAdapter.js';

/**
 * Runs one or more scorers without exposing ground-truth labels to them.
 * scorer signature: async ({ id, source, features }) => number in [0,1]
 */
export async function runBlindAmlBenchmark(dataset, scorers, opts = {}) {
  if (!dataset?.samples || !(dataset.labels instanceof Map)) throw new TypeError('invalid benchmark dataset');
  const threshold = opts.threshold ?? 0.5;
  const ids = dataset.samples.map((sample) => sample.id);
  const groundTruth = revealEllipticLabels(dataset.labels, ids);
  const results = {};

  for (const [name, scorer] of Object.entries(scorers || {})) {
    if (typeof scorer !== 'function') continue;
    // Only sanitized samples are passed. Ground truth remains outside scorer scope.
    const scores = [];
    for (const sample of dataset.samples) {
      const input = { id: sample.id, source: sample.source, features: [...sample.features] };
      const score = Number(await scorer(input));
      scores.push(Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0);
    }
    results[name] = {
      sampleCount: dataset.samples.length,
      evaluatedCount: groundTruth.filter((x) => x !== 'unknown').length,
      metrics: binaryMetrics(groundTruth, scores, threshold),
      scores,
    };
  }

  return {
    dataset: 'Elliptic Bitcoin transaction graph',
    positiveClass: 'illicit',
    leakageGuard: true,
    results,
  };
}
