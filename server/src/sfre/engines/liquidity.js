import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../core/result.js';

const ENGINE = 'liquidity';
export const DEFAULT_PARTICIPATION = 0.2; // practitioner convention -- UNCALIBRATED

/** DTL_k = shares_k / (pi * ADV_k). ADV null/<=0 => DTL unobserved (not 0, not Infinity-as-safe). */
export function daysToLiquidate(positions, { participation = DEFAULT_PARTICIPATION } = {}) {
  const params = { participation, participationProvenance: participation === DEFAULT_PARTICIPATION ? 'convention-default' : 'caller-supplied' };
  if (!(participation > 0 && participation <= 1)) return failed(ENGINE, 'M04.dtl', 'participation must be in (0,1]', { parameters: params });
  const rows = positions.map((p) => ({
    asset: p.asset,
    dtl: Number.isFinite(p.adv) && p.adv > 0 && Number.isFinite(p.shares) && p.shares >= 0 ? p.shares / (participation * p.adv) : null,
    value: Number.isFinite(p.value) ? p.value : null,
  }));
  const unobserved = rows.filter((r) => r.dtl === null).map((r) => `dtl:${r.asset}`);
  return makeResult({
    engine: ENGINE, modelId: 'M04.dtl', status: unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: rows, coverage: coverageOf(rows.length - unobserved.length, rows.length), unobserved,
    calibration: CALIBRATION.UNCALIBRATED, parameters: params,
  });
}

/** L(h) = share of portfolio value liquidatable within h days. Unobserved-DTL value is reported separately (not assumed liquid or illiquid). */
export function liquidityProfile(dtlRows, horizonsDays = [1, 5, 20]) {
  const total = dtlRows.reduce((s, r) => s + (r.value ?? 0), 0);
  if (!(total > 0)) return failed(ENGINE, 'M04.profile', 'zero total value');
  const unknownValue = dtlRows.filter((r) => r.dtl === null).reduce((s, r) => s + (r.value ?? 0), 0);
  const profile = horizonsDays.map((h) => {
    const v = dtlRows.filter((r) => r.dtl !== null && r.dtl <= h).reduce((s, r) => s + (r.value ?? 0), 0);
    return { horizonDays: h, liquidatableShare: v / total, upperBoundShare: (v + unknownValue) / total };
  });
  return makeResult({
    engine: ENGINE, modelId: 'M04.profile', status: unknownValue > 0 ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value: { profile, unobservedLiquidityShare: unknownValue / total }, coverage: coverageOf(total - unknownValue, total),
    unobserved: dtlRows.filter((r) => r.dtl === null).map((r) => `dtl:${r.asset}`), parameters: { horizonsDays },
  });
}
