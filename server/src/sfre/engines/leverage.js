import { makeResult, failed, STATUS, CALIBRATION } from '../core/result.js';

const ENGINE = 'leverage';

/** Margin deleveraging sale A* = max(0, GA - E/m): selling A and repaying A of debt restores E/(GA-A) >= m. */
export function marginSaleRequired({ grossAssets, debt, marginRatio }) {
  if (debt === null || debt === undefined || marginRatio === null || marginRatio === undefined) return null; // UNOBSERVED
  const E = grossAssets - debt;
  if (E <= 0) return grossAssets; // insolvent: everything must go
  return Math.max(0, grossAssets - E / marginRatio);
}

/** Leverage assessment. debt == null => INSUFFICIENT_OBSERVABILITY; optional explicit assumed upper bound is labelled ASSUMED. */
export function assessLeverage({ id, grossAssets, debt = null, marginRatio = null, assumedMaxLeverage = null }) {
  if (!(grossAssets > 0)) return failed(ENGINE, 'M06.leverage', `${id}: grossAssets must be > 0`);
  if (debt === null || debt === undefined) {
    const sens = assumedMaxLeverage && assumedMaxLeverage >= 1
      ? { basis: 'ASSUMED', assumedMaxLeverage, impliedDebt: grossAssets * (1 - 1 / assumedMaxLeverage) }
      : null;
    return makeResult({
      engine: ENGINE, modelId: 'M06.leverage', status: STATUS.INSUFFICIENT_OBSERVABILITY, value: { sensitivity: sens },
      unobserved: [`debt:${id}`], calibration: CALIBRATION.UNCALIBRATED, parameters: { assumedMaxLeverage },
      notes: ['leverage is unobserved; it is NOT assumed to be zero'],
    });
  }
  const E = grossAssets - debt;
  const margin = marginSaleRequired({ grossAssets, debt, marginRatio });
  return makeResult({
    engine: ENGINE, modelId: 'M06.leverage', status: STATUS.MEASURED,
    value: { equity: E, leverage: E > 0 ? grossAssets / E : null, marginSaleRequired: margin, insolvent: E <= 0 },
    unobserved: marginRatio === null || marginRatio === undefined ? [`margin_ratio:${id}`] : [], parameters: {},
  });
}
