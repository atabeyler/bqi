import { query } from '../db/client.js';

export const RISK_FORECAST_MODEL_VERSION = 1;
const MIN_SAMPLES = 3;

export function forecastRiskTrend(samples, horizonDays = 30) {
  const usable = (samples || [])
    .map((sample) => ({ at: new Date(sample.computedAt || sample.computed_at).getTime(), score: Number(sample.riskScore ?? sample.risk_score) }))
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.score))
    .sort((a, b) => a.at - b.at);
  if (usable.length < MIN_SAMPLES) {
    return { status: 'INSUFFICIENT_DATA', sampleCount: usable.length, requiredSampleCount: MIN_SAMPLES, forecast: null, confidence: 0, modelVersion: RISK_FORECAST_MODEL_VERSION };
  }

  const origin = usable[0].at;
  const points = usable.map((sample) => ({ x: (sample.at - origin) / 86_400_000, y: sample.score }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) {
    return { status: 'INSUFFICIENT_TIME_SPAN', sampleCount: usable.length, requiredSampleCount: MIN_SAMPLES, forecast: null, confidence: 0, modelVersion: RISK_FORECAST_MODEL_VERSION };
  }
  const slopePerDay = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - slopePerDay * meanX;
  const predicted = points.map((point) => intercept + slopePerDay * point.x);
  const residual = points.reduce((sum, point, index) => sum + (point.y - predicted[index]) ** 2, 0);
  const total = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const rSquared = total === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / total));
  const lastDay = points.at(-1).x;
  const forecastScore = Math.round(Math.max(0, Math.min(100, intercept + slopePerDay * (lastDay + horizonDays))));
  const confidence = Math.round(100 * rSquared * Math.min(1, usable.length / 8));

  return {
    status: 'FORECAST_AVAILABLE',
    sampleCount: usable.length,
    horizonDays,
    forecast: { score: forecastScore, slopePerDay, direction: slopePerDay > 0.05 ? 'INCREASING' : slopePerDay < -0.05 ? 'DECREASING' : 'STABLE' },
    confidence,
    rSquared,
    modelVersion: RISK_FORECAST_MODEL_VERSION,
  };
}

export async function forecastAssetRisk(orgId, assetId, horizonDays = 30) {
  const { rows } = await query(
    `SELECT risk_score, computed_at FROM asset_risk_snapshots
      WHERE org_id = $1 AND asset_id = $2 AND risk_score IS NOT NULL
      ORDER BY computed_at ASC`,
    [orgId, assetId]
  );
  return forecastRiskTrend(rows, horizonDays);
}
