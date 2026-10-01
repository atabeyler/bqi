import { makeResult, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { finite } from '../../core/stats.js';
import { Rng } from '../../core/prng.js';
import { PARAMS, robustZDetector, ewmaDetector, cusumDetector, changePointDetector, isolationForestDetector, lofDetector, embed } from './detectors.js';

const ENGINE = 'anomaly';
const MODELS = ['robust_z', 'ewma', 'cusum', 'change_point', 'isolation_forest', 'lof'];

const binaryEntropy = (p) => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

/**
 * Ensemble anomaly detection with explicit disagreement.
 *  reference: numbers strictly before `evaluation` in time.
 *  features (optional): {reference: number[][], evaluation: number[][]} for the multivariate detectors;
 *  otherwise a (x_t, dx_t) embedding of the series is used.
 * Outputs per-model verdicts, consensus, disagreement and coverage. Verdicts are never averaged into a hidden score.
 */
export function detectAnomalies({ reference, evaluation, features = null, seed = 1, label = 'series' }) {
  const refClean = reference.filter(finite);
  const ev = [];
  const models = [
    robustZDetector(reference, evaluation),
    ewmaDetector(reference, evaluation),
    cusumDetector(reference, evaluation),
    changePointDetector(reference, evaluation),
  ];
  const rng = new Rng(seed);
  const refPts = features ? features.reference : embed(refClean, undefined);
  const evPts = features ? features.evaluation : embed(evaluation, refClean[refClean.length - 1]);
  models.push(isolationForestDetector(refPts, evPts, rng.child('iforest')));
  models.push(lofDetector(refPts, evPts));
  void ev;
  const avail = models.filter((m) => m.status === 'SIGNAL' || m.status === 'NO_SIGNAL');
  const signaling = avail.filter((m) => m.status === 'SIGNAL').map((m) => m.model);
  const quiet = avail.filter((m) => m.status === 'NO_SIGNAL').map((m) => m.model);
  const unavailable = models.filter((m) => m.status === 'INSUFFICIENT_DATA').map((m) => ({ model: m.model, reason: m.detail }));
  const coverage = coverageOf(avail.length, MODELS.length);
  const consensus = avail.length ? signaling.length / avail.length : null;
  const disagreement = consensus === null ? null : binaryEntropy(consensus);
  let status;
  if (coverage.fraction < 0.5) status = STATUS.INSUFFICIENT_DATA;
  else if (signaling.length === avail.length) status = STATUS.SIGNAL;
  else if (signaling.length === 0) status = STATUS.NO_SIGNAL;
  else status = STATUS.MODEL_DISAGREEMENT;
  return makeResult({
    engine: ENGINE, modelId: 'M20.anomaly_ensemble', status,
    value: {
      label, models: models.map(({ model, status: st, score, threshold, flagged }) => ({ model, status: st, score, threshold, flagged })),
      signalingModels: signaling, quietModels: quiet, unavailableModels: unavailable, consensus, disagreement,
    },
    uncertainty: { disagreementBits: disagreement, consensus },
    coverage, unobserved: unavailable.map((u) => `model:${u.model}`), calibration: CALIBRATION.UNCALIBRATED, parameters: { ...PARAMS, seed },
    notes: ['NO_SIGNAL is not safety; thresholds are conventions, not calibrated alarm rates', status === STATUS.MODEL_DISAGREEMENT ? 'models disagree: both camps listed, no averaging' : ''].filter(Boolean),
  });
}
