import { STATUS } from '../core/result.js';

export const DISCLAIMER = 'Bu tablo yatırım tavsiyesi değildir. AL/SAT/TUT önerisi içermez; ölçülmüş anomali, belirsizlik ve veri kapsamını gösterir. Hiçbir kişi veya şirket hakkında suç isnadı içermez.';

export const DIMENSIONS = Object.freeze([
  ['price_anomaly', 'Fiyat anomalisi'], ['volume_anomaly', 'Hacim anomalisi'], ['fundamental_divergence', 'Temel-finansal ayrışma'],
  ['valuation_divergence', 'Değerleme ayrışması'], ['liquidity', 'Likidite'], ['concentration', 'Fon/portföy yoğunlaşması'],
  ['disclosure_consistency', 'KAP/açıklama tutarlılığı'], ['attention_promotion', 'Attention/promotional anomaly'], ['insider_transactions', 'Ortak/yönetici işlemleri'],
  ['contagion', 'Contagion riski'], ['model_disagreement', 'Model disagreement'], ['data_coverage', 'Data coverage'], ['uncertainty', 'Uncertainty'],
]);

const excerpt = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => ['number', 'string', 'boolean'].includes(typeof x) || x === null).slice(0, 8)) : v);

function row(key, label, res, claimId = null, extra = {}) {
  if (!res) return { key, label, status: STATUS.INSUFFICIENT_OBSERVABILITY, reason: 'no engine result supplied for this dimension', measurement: null, coverage: null, claim_id: null, ...extra };
  return { key, label, status: res.status, model_id: res.model_id, calibration: res.calibration, measurement: excerpt(res.value), coverage: res.coverage, unobserved: res.unobserved, claim_id: claimId, ...extra };
}

/**
 * Builds the retail risk table from engine results (keyed by dimension). A missing result is
 * INSUFFICIENT_OBSERVABILITY, never "low risk". No composite score (would need arbitrary weights); no BUY/SELL/HOLD.
 * results: {price_anomaly, volume_anomaly, ..., contagion, tail}; claimIds: same keys -> ledger claim id.
 */
export function buildRetailRiskTable(results, claimIds = {}) {
  const rows = DIMENSIONS.filter(([k]) => !['model_disagreement', 'data_coverage', 'uncertainty'].includes(k)).map(([k, label]) => row(k, label, results[k], claimIds[k] ?? null));
  const present = Object.values(results).filter(Boolean);
  const disagree = present.filter((r) => r.status === STATUS.MODEL_DISAGREEMENT);
  rows.push({ key: 'model_disagreement', label: 'Model disagreement', status: present.length === 0 ? STATUS.INSUFFICIENT_OBSERVABILITY : disagree.length ? STATUS.MODEL_DISAGREEMENT : STATUS.NO_SIGNAL, measurement: { disagreeingEngines: disagree.map((r) => r.model_id) }, claim_id: null });
  const covs = present.map((r) => r.coverage?.fraction).filter((x) => typeof x === 'number');
  const minCov = covs.length ? Math.min(...covs) : null;
  rows.push({ key: 'data_coverage', label: 'Data coverage', status: minCov === null ? STATUS.INSUFFICIENT_OBSERVABILITY : minCov < 1 ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED, measurement: { minimumCoverage: minCov, dimensionsWithResult: present.length, dimensionsTotal: DIMENSIONS.length - 3 }, claim_id: null });
  const counts = {}; for (const r of present) counts[r.status] = (counts[r.status] || 0) + 1;
  rows.push({ key: 'uncertainty', label: 'Uncertainty', status: STATUS.MEASURED, measurement: { statusCounts: counts, uncalibratedEngines: present.filter((r) => r.calibration !== 'CALIBRATED').length, totalEngines: present.length }, claim_id: null });
  return { disclaimer: DISCLAIMER, rows, composite_score: null, recommendation: null };
}
