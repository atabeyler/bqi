import { makeResult, failed, STATUS, CALIBRATION } from '../core/result.js';

const ENGINE = 'impact';

/**
 * Fractional price decline from aggregate sales Q (TRY) in one asset.
 * Returns null when the model's required inputs are unobserved (never 0).
 *  - amihud-linear: d = min(1, ILLIQ * Q)
 *  - sqrt:          d = min(1, Y * sigma * sqrt(Q / ADVvalue))   (Y has no default)
 */
export function priceImpact(model, asset, Q) {
  if (!(Q >= 0)) return null;
  if (Q === 0) return 0;
  if (model.model === 'amihud-linear') {
    if (!Number.isFinite(asset.illiq) || asset.illiq < 0) return null;
    return Math.min(1, asset.illiq * Q * (model.scale ?? 1));
  }
  if (model.model === 'sqrt') {
    if (!Number.isFinite(model.Y) || !Number.isFinite(asset.sigma) || !(asset.advValue > 0)) return null;
    return Math.min(1, model.Y * asset.sigma * Math.sqrt(Q / asset.advValue) * (model.scale ?? 1));
  }
  return null;
}

export function validateImpactModel(model) {
  if (!model || !['amihud-linear', 'sqrt'].includes(model.model)) return 'impact.model must be amihud-linear or sqrt';
  if (model.model === 'sqrt' && !Number.isFinite(model.Y)) return 'sqrt impact requires caller-supplied Y (no default)';
  if (model.scale !== undefined && !(model.scale >= 0)) return 'impact.scale must be >= 0';
  return null;
}

export function impactCurve(model, asset, Qs) {
  const err = validateImpactModel(model);
  if (err) return failed(ENGINE, 'M07.impact', err);
  const curve = Qs.map((Q) => ({ Q, d: priceImpact(model, asset, Q) }));
  const missing = curve.some((c) => c.d === null);
  return makeResult({
    engine: ENGINE, modelId: model.model === 'sqrt' ? 'M07.sqrt' : 'M07.amihud_linear',
    status: missing ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED, value: curve,
    calibration: model.model === 'amihud-linear' ? CALIBRATION.ESTIMATED : CALIBRATION.UNCALIBRATED,
    parameters: { model: model.model, Y: model.Y ?? null, scale: model.scale ?? 1 },
    unobserved: missing ? ['impact_inputs'] : [],
  });
}
