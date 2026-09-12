/**
 * Scorers for Elliptic's 166 numeric transaction features.
 * These are benchmark-specific adapters; they do not pretend Elliptic exposes
 * bank-account behavioral fields required by the production 13Q AML service.
 */

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function median(sortedValues) {
  return sortedValues.length ? sortedValues[Math.floor(sortedValues.length / 2)] : 0;
}

/**
 * Robust multivariate outlier score: median/MAD z-score per feature, then
 * mean of squared z (capped per-dimension) across ALL dimensions -- not just
 * the top-K.
 *
 * The original version averaged the top-8 |z| out of 165 dimensions. With
 * that many dimensions, several exceed |z|>2 by chance alone (order
 * statistics of 165 draws), so the "top-8" score saturated near its max for
 * almost every real Elliptic sample regardless of label (measured: p50=0.997,
 * p90=0.998 on validation) -- it was effectively flagging everyone.
 * Averaging over every dimension instead of cherry-picking extremes removes
 * that multiple-comparisons inflation.
 *
 * The sigmoid is also calibrated against the reference population's own raw
 * score distribution (median/MAD of raw scores over the unlabeled reference
 * set -- no ground truth used) instead of hardcoded constants that were
 * never checked against real data.
 */
export function createRobustClassicalScorer(referenceSamples) {
  const matrix = referenceSamples.map((s) => s.features);
  const width = Math.max(0, ...matrix.map((r) => r.length));
  const stats = Array.from({ length: width }, (_, j) => {
    const xs = matrix.map((r) => Number(r[j])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return { med: 0, mad: 1 };
    const med = median(xs);
    const dev = xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const mad = median(dev) || 1;
    return { med, mad };
  });

  const rawScore = (sample) => {
    if (!sample.features.length) return 0;
    let sum = 0;
    for (let j = 0; j < sample.features.length; j++) {
      const z = (Number(sample.features[j]) - stats[j].med) / (1.4826 * stats[j].mad || 1);
      sum += Math.min(z * z, 25);
    }
    return sum / sample.features.length;
  };

  const rawScores = referenceSamples.map(rawScore).sort((a, b) => a - b);
  const rawMedian = median(rawScores);
  const rawDev = rawScores.map((x) => Math.abs(x - rawMedian)).sort((a, b) => a - b);
  const rawMad = median(rawDev) || 1;

  return async (sample) => sigmoid((rawScore(sample) - rawMedian) / (1.4826 * rawMad || 1));
}

/** Deterministic nonlinear 5D feature-map proxy for the existing 5Q kernel. */
export function createElliptic5QScorer(referenceSamples) {
  const classical = createRobustClassicalScorer(referenceSamples);
  return async (sample) => {
    const base = await classical(sample);
    const f = sample.features;
    if (!f.length) return base;
    const projected = [0, 1, 2, 3, 4].map((q) => {
      let sum = 0;
      for (let i = q; i < f.length; i += 5) sum += Math.sin(Number(f[i]) * (q + 1)) + Math.cos(Number(f[i]) * 0.5);
      return sum / Math.ceil(f.length / 5);
    });
    const coherence = projected.reduce((s, x) => s + Math.abs(Math.sin(x)), 0) / 5;
    return Math.max(0, Math.min(1, 0.75 * base + 0.25 * coherence));
  };
}

/** Deterministic nonlinear 13D proxy used only to test feature-map dimensionality on Elliptic. */
export function createElliptic13QScorer(referenceSamples) {
  const classical = createRobustClassicalScorer(referenceSamples);
  return async (sample) => {
    const base = await classical(sample);
    const f = sample.features;
    if (!f.length) return base;
    const projected = Array.from({ length: 13 }, (_, q) => {
      let sum = 0; let n = 0;
      for (let i = q; i < f.length; i += 13) { sum += Math.sin(Number(f[i]) * (q + 1) / 3) + Math.cos(Number(f[i]) * (q + 2) / 7); n++; }
      return n ? sum / n : 0;
    });
    const coherence = projected.reduce((s, x) => s + Math.abs(Math.sin(x)), 0) / 13;
    return Math.max(0, Math.min(1, 0.7 * base + 0.3 * coherence));
  };
}
