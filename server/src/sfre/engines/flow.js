import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { ols, finite } from '../core/stats.js';
import { bootstrapCI } from './uncertainty.js';

const ENGINE = 'flow';
export const MIN_FLOW_OBS = 30;

/**
 * Flow-performance sensitivity: netFlowRatio_t = a + b * return_{t-1} + e  (inflow positive).
 * beta = max(0, b): redemption (as a fraction of NAV) induced per unit fractional loss.
 * In the cascade, redemption_TRY = beta * loss_TRY.
 */
export function estimateRedemptionSensitivity({ returns, netFlowRatio, rng = null }) {
  const xs = []; const ys = [];
  for (let t = 1; t < Math.min(returns.length, netFlowRatio.length); t++) {
    if (finite(returns[t - 1]) && finite(netFlowRatio[t])) { xs.push(returns[t - 1]); ys.push(netFlowRatio[t]); }
  }
  if (xs.length < MIN_FLOW_OBS) return makeResult({ engine: ENGINE, modelId: 'M05.flow_sensitivity', status: STATUS.INSUFFICIENT_DATA, coverage: coverageOf(xs.length, MIN_FLOW_OBS), parameters: {}, notes: ['beta stays UNOBSERVED; the secondary-redemption channel must not default to zero'] });
  const fit = ols(xs, ys);
  if (!fit) return makeResult({ engine: ENGINE, modelId: 'M05.flow_sensitivity', status: STATUS.COMPUTATION_FAILED, error: 'degenerate regression', parameters: {} });
  let ci = null;
  if (rng) { const pairs = xs.map((x, i) => [x, ys[i]]); ci = bootstrapCI(pairs, (p) => ols(p.map((q) => q[0]), p.map((q) => q[1]))?.b ?? NaN, rng); }
  return makeResult({
    engine: ENGINE, modelId: 'M05.flow_sensitivity', status: STATUS.MEASURED,
    value: { slope: fit.b, beta: Math.max(0, fit.b), n: fit.n, r2: fit.r2 },
    uncertainty: { slopeStdErr: fit.seB, bootstrapCI: ci },
    coverage: coverageOf(xs.length, xs.length), calibration: CALIBRATION.ESTIMATED, parameters: { minObs: MIN_FLOW_OBS },
    notes: ['in-sample estimate; not validated out-of-sample'],
  });
}
