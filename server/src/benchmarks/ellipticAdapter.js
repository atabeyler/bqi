/**
 * Elliptic Bitcoin transaction dataset adapter.
 * Labels are deliberately kept separate from model inputs to prevent leakage.
 * Expected raw inputs: class rows [txId,class] and feature rows [txId,...features].
 */

const LABEL_MAP = Object.freeze({ '1': 'illicit', '2': 'licit', unknown: 'unknown' });

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeEllipticLabel(value) {
  const key = String(value ?? 'unknown').trim().toLowerCase();
  return LABEL_MAP[key] || (key === 'licit' || key === 'illicit' ? key : 'unknown');
}

export function adaptEllipticRows(featureRows, classRows = []) {
  if (!Array.isArray(featureRows)) throw new TypeError('featureRows must be an array');

  const labels = new Map(
    classRows.map((row) => [String(row.txId ?? row[0]), normalizeEllipticLabel(row.class ?? row.label ?? row[1])])
  );

  const samples = featureRows.map((row, index) => {
    const txId = String(row.txId ?? row.id ?? row[0] ?? index);
    const values = Array.isArray(row)
      ? row.slice(1).map((v) => finite(v))
      : Object.entries(row)
          .filter(([key]) => !['txId', 'id', 'class', 'label'].includes(key))
          .map(([, value]) => finite(value));

    return {
      id: txId,
      source: 'elliptic',
      features: values,
    };
  });

  return {
    samples,
    labels,
    knownSampleCount: samples.reduce((n, sample) => n + (labels.get(sample.id) !== 'unknown' ? 1 : 0), 0),
  };
}

export function revealEllipticLabels(labels, ids) {
  return ids.map((id) => labels.get(String(id)) || 'unknown');
}
