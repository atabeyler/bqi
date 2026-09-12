function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

function knownTrainingRows(part) {
  const rows = [];
  for (const sample of part.samples) {
    const label = part.labels.get(sample.id) || 'unknown';
    if (label === 'unknown') continue;
    rows.push({ x: sample.features.map(Number), y: label === 'illicit' ? 1 : 0 });
  }
  return rows;
}

/**
 * Lightweight supervised baseline with no external ML dependency.
 * Fits a class-balanced logistic model on KNOWN TRAIN labels only.
 * Validation remains reserved for threshold/orientation selection and test
 * remains blind until final metrics are computed.
 */
export function createBalancedLinearScorer(trainPart, opts = {}) {
  const rows = knownTrainingRows(trainPart);
  if (!rows.length) throw new Error('no known labeled training rows');
  const width = Math.max(...rows.map((r) => r.x.length));
  const mean = new Float64Array(width);
  const variance = new Float64Array(width);

  for (const r of rows) for (let j = 0; j < width; j++) mean[j] += Number.isFinite(r.x[j]) ? r.x[j] : 0;
  for (let j = 0; j < width; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < width; j++) {
    const d = (Number.isFinite(r.x[j]) ? r.x[j] : 0) - mean[j];
    variance[j] += d * d;
  }
  const scale = new Float64Array(width);
  for (let j = 0; j < width; j++) scale[j] = Math.sqrt(variance[j] / Math.max(1, rows.length - 1)) || 1;

  const positives = rows.reduce((n, r) => n + r.y, 0);
  const negatives = rows.length - positives;
  const posWeight = positives ? rows.length / (2 * positives) : 1;
  const negWeight = negatives ? rows.length / (2 * negatives) : 1;
  const weights = new Float64Array(width);
  let bias = 0;
  const epochs = opts.epochs ?? 35;
  const lr = opts.learningRate ?? 0.08;
  const l2 = opts.l2 ?? 1e-4;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Float64Array(width);
    let gradBias = 0;
    for (const r of rows) {
      let z = bias;
      for (let j = 0; j < width; j++) z += weights[j] * (((Number.isFinite(r.x[j]) ? r.x[j] : 0) - mean[j]) / scale[j]);
      const p = sigmoid(z);
      const cw = r.y ? posWeight : negWeight;
      const err = cw * (p - r.y);
      gradBias += err;
      for (let j = 0; j < width; j++) grad[j] += err * (((Number.isFinite(r.x[j]) ? r.x[j] : 0) - mean[j]) / scale[j]);
    }
    const step = lr / rows.length;
    bias -= step * gradBias;
    for (let j = 0; j < width; j++) weights[j] -= step * (grad[j] + l2 * rows.length * weights[j]);
  }

  return async (sample) => {
    let z = bias;
    for (let j = 0; j < width; j++) {
      const v = Number(sample.features[j]);
      z += weights[j] * (((Number.isFinite(v) ? v : 0) - mean[j]) / scale[j]);
    }
    return sigmoid(z);
  };
}
