import { hashOf, deepFreeze } from './canonical.js';

export const STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  SIGNAL: 'SIGNAL',
  NO_SIGNAL: 'NO_SIGNAL',
  LOW_RISK: 'LOW_RISK',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  INSUFFICIENT_OBSERVABILITY: 'INSUFFICIENT_OBSERVABILITY',
  MODEL_UNCERTAIN: 'MODEL_UNCERTAIN',
  MODEL_DISAGREEMENT: 'MODEL_DISAGREEMENT',
  UNCALIBRATED: 'UNCALIBRATED',
  COMPUTATION_FAILED: 'COMPUTATION_FAILED',
});

export const CALIBRATION = Object.freeze({
  UNCALIBRATED: 'UNCALIBRATED',
  ESTIMATED: 'ESTIMATED',
  CALIBRATED: 'CALIBRATED',
});

export const UNOBSERVED = null; // marker: value is not present in point-in-time data

const STATUS_SET = new Set(Object.values(STATUS));
const CAL_SET = new Set(Object.values(CALIBRATION));

/**
 * Single envelope for every engine output. Enforces the failure-semantics
 * invariant: LOW_RISK is only constructible with full coverage AND a
 * CALIBRATED model. Missing data can never read as low risk.
 */
export function makeResult({
  engine,
  modelId,
  modelVersion = '1.0.0',
  status,
  value = null,
  uncertainty = null,
  coverage = null,
  unobserved = [],
  calibration = CALIBRATION.UNCALIBRATED,
  parameters = {},
  inputHashes = [],
  notes = [],
  error = null,
}) {
  if (!STATUS_SET.has(status)) throw new Error(`makeResult: unknown status ${status}`);
  if (!CAL_SET.has(calibration)) throw new Error(`makeResult: unknown calibration ${calibration}`);
  if (status === STATUS.LOW_RISK) {
    const full = coverage && coverage.fraction === 1;
    if (!full || calibration !== CALIBRATION.CALIBRATED || unobserved.length > 0) {
      throw new Error('makeResult: LOW_RISK requires full coverage, no unobserved inputs and a CALIBRATED model');
    }
  }
  const res = {
    engine,
    model_id: modelId,
    model_version: modelVersion,
    status,
    value,
    uncertainty,
    coverage,
    unobserved: [...unobserved],
    calibration,
    parameters,
    parameter_hash: hashOf(parameters),
    input_hashes: [...inputHashes],
    notes: [...notes],
    error,
  };
  res.result_hash = hashOf({ ...res, result_hash: undefined });
  return deepFreeze(res);
}

export function failed(engine, modelId, message, extra = {}) {
  return makeResult({ engine, modelId, status: STATUS.COMPUTATION_FAILED, error: String(message), ...extra });
}

export function coverageOf(observed, total) {
  return { observed, total, fraction: total === 0 ? 0 : observed / total };
}
