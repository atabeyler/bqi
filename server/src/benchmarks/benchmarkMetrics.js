/** Binary AML benchmark metrics. Positive class = illicit. */

function div(a, b) { return b ? a / b : 0; }

export function confusionMatrix(labels, predictions) {
  if (labels.length !== predictions.length) throw new Error('labels/predictions length mismatch');
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i];
    if (y === 'unknown') continue;
    const p = predictions[i];
    if (y === 'illicit' && p === 'illicit') tp++;
    else if (y === 'licit' && p === 'illicit') fp++;
    else if (y === 'licit' && p === 'licit') tn++;
    else if (y === 'illicit' && p === 'licit') fn++;
  }
  return { tp, fp, tn, fn };
}

export function binaryMetrics(labels, scores, threshold = 0.5) {
  if (labels.length !== scores.length) throw new Error('labels/scores length mismatch');
  const predictions = scores.map((score) => Number(score) >= threshold ? 'illicit' : 'licit');
  const cm = confusionMatrix(labels, predictions);
  const precision = div(cm.tp, cm.tp + cm.fp);
  const recall = div(cm.tp, cm.tp + cm.fn);
  const f1 = div(2 * precision * recall, precision + recall);
  const fpr = div(cm.fp, cm.fp + cm.tn);
  return { threshold, ...cm, precision, recall, f1, fpr, prAuc: precisionRecallAuc(labels, scores) };
}

export function precisionRecallAuc(labels, scores) {
  const rows = labels.map((label, i) => ({ label, score: Number(scores[i]) }))
    .filter((r) => r.label !== 'unknown' && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);
  const positives = rows.filter((r) => r.label === 'illicit').length;
  if (!positives) return 0;

  let tp = 0; let fp = 0; let previousRecall = 0; let area = 0;
  for (const row of rows) {
    if (row.label === 'illicit') tp++; else fp++;
    const recall = tp / positives;
    const precision = tp / (tp + fp);
    area += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return area;
}
