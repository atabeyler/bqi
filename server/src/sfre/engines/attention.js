import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { finite, robustScale, median } from '../core/stats.js';

const ENGINE = 'attention';
export const Z = 3.5;
export const MIN_REF = 30;

/**
 * Asset-level attention anomaly (aggregate counts only; no individual profiling).
 * fundamentalsSupport: 'SUPPORTED' | 'NOT_SUPPORTED' | null (null = UNOBSERVED).
 */
export function attentionAnomaly({ attentionRef, attentionEval, returnZ = null, volumeZ = null, fundamentalsSupport = null }) {
  const ref = (attentionRef || []).filter(finite);
  const params = { Z, minRef: MIN_REF };
  if (ref.length < MIN_REF) return makeResult({ engine: ENGINE, modelId: 'M51.attention', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(ref.length, MIN_REF), parameters: params });
  const s = robustScale(ref);
  if (!(s > 0)) return makeResult({ engine: ENGINE, modelId: 'M51.attention', status: STATUS.MODEL_UNCERTAIN, parameters: params, notes: ['reference attention has zero spread'] });
  const zs = (attentionEval || []).filter(finite).map((x) => (x - median(ref)) / s);
  const attnZ = zs.length ? Math.max(...zs) : null;
  if (attnZ === null) return makeResult({ engine: ENGINE, modelId: 'M51.attention', status: STATUS.INSUFFICIENT_OBSERVABILITY, unobserved: ['attention_eval'], parameters: params });
  const attnHigh = attnZ > Z; const retHigh = finite(returnZ) && returnZ > Z; const volHigh = finite(volumeZ) && volumeZ > Z;
  const unobserved = []; if (!finite(returnZ)) unobserved.push('returnZ'); if (!finite(volumeZ)) unobserved.push('volumeZ'); if (fundamentalsSupport === null) unobserved.push('fundamentalsSupport');
  const co = attnHigh && retHigh && volHigh;
  let label = 'NONE'; let status = STATUS.NO_SIGNAL;
  if (unobserved.includes('returnZ') || unobserved.includes('volumeZ')) { status = STATUS.INSUFFICIENT_OBSERVABILITY; label = attnHigh ? 'ATTENTION_ANOMALY_ONLY' : 'NONE'; }
  else if (co && fundamentalsSupport === 'NOT_SUPPORTED') { label = 'PROMOTION_MARKET_DIVERGENCE'; status = STATUS.SIGNAL; }
  else if (co && fundamentalsSupport === 'SUPPORTED') { label = 'CO_ANOMALY_FUNDAMENTALLY_SUPPORTED'; }
  else if (co) { label = 'ATTENTION_PRICE_VOLUME_CO_ANOMALY'; status = STATUS.INSUFFICIENT_OBSERVABILITY; }
  else if (attnHigh) label = 'ATTENTION_ANOMALY_ONLY';
  return makeResult({
    engine: ENGINE, modelId: 'M51.attention', status, value: { label, attentionZ: attnZ, returnZ, volumeZ, fundamentalsSupport },
    coverage: coverageOf(4 - unobserved.length, 4), unobserved, calibration: CALIBRATION.UNCALIBRATED, parameters: params,
    notes: ['aggregate counts only; unobserved fundamentals are NOT treated as unsupportive', 'not an allegation of promotion by any person'],
  });
}
