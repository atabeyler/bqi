import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { robustZ, finite } from '../core/stats.js';

const ENGINE = 'accountingQuality';
export const BENEISH = Object.freeze({ intercept: -4.84, DSRI: 0.92, GMI: 0.528, AQI: 0.404, SGI: 0.892, DEPI: 0.115, SGAI: -0.172, TATA: 4.679, LVGI: -0.327, cutoff: -1.78, source: 'Beneish (1999), US manufacturing 1982-1992' });
export const AUDIT_OPINIONS = ['UNQUALIFIED', 'UNQUALIFIED_EMPHASIS', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER'];
const DISCLAIMER = 'No model, including this one, is evidence of fraud. These are accounting-quality indicators only.';
const pos = (x) => finite(x) && x > 0;

/** Beneish 8-variable M-score. Any missing component => UNOBSERVED (no neutral imputation). t = current, p = prior year. */
export function beneishMScore(t, p) {
  const need = ['revenue', 'cogs', 'receivables', 'ppe', 'total_assets', 'depreciation', 'sga', 'net_income', 'cfo', 'current_assets', 'securities', 'current_liabilities', 'lt_debt'];
  const missing = [];
  for (const f of need) { if (!finite(t?.[f])) missing.push(`t.${f}`); if (!finite(p?.[f])) missing.push(`p.${f}`); }
  if (missing.length) return { computable: false, unobserved: missing };
  const gm = (x) => (x.revenue - x.cogs) / x.revenue;
  const aq = (x) => 1 - (x.current_assets + x.ppe + x.securities) / x.total_assets;
  const dep = (x) => x.depreciation / (x.depreciation + x.ppe);
  const lev = (x) => (x.current_liabilities + x.lt_debt) / x.total_assets;
  if ([p.revenue, t.revenue, p.receivables, p.total_assets, t.total_assets].some((v) => !(v > 0)) || gm(t) === 0 || gm(p) === 0 || aq(p) === 0 || !(dep(t) > 0) || !(dep(p) >= 0) || !(p.sga > 0) || !(lev(p) > 0)) return { computable: false, unobserved: [], degenerate: true };
  const idx = {
    DSRI: (t.receivables / t.revenue) / (p.receivables / p.revenue),
    GMI: gm(p) / gm(t),
    AQI: aq(t) / aq(p),
    SGI: t.revenue / p.revenue,
    DEPI: dep(p) / dep(t),
    SGAI: (t.sga / t.revenue) / (p.sga / p.revenue),
    TATA: (t.net_income - t.cfo) / t.total_assets,
    LVGI: lev(t) / lev(p),
  };
  const M = BENEISH.intercept + BENEISH.DSRI * idx.DSRI + BENEISH.GMI * idx.GMI + BENEISH.AQI * idx.AQI + BENEISH.SGI * idx.SGI + BENEISH.DEPI * idx.DEPI + BENEISH.SGAI * idx.SGAI + BENEISH.TATA * idx.TATA + BENEISH.LVGI * idx.LVGI;
  return { computable: true, M, indices: idx, aboveCutoff: M > BENEISH.cutoff };
}

/** Bundle of accounting-quality indicators. Output is indicators, never a fraud verdict. */
export function accountingQuality({ current, prior, marginHistory = [], auditOpinion = null, relatedPartyRevenue = null, oneOffIncome = null }) {
  const ind = {};
  const unobserved = [];
  const put = (k, v, why) => { ind[k] = v; if (v === null) unobserved.push(`indicator.${k}${why ? `(${why})` : ''}`); };
  put('cfoMinusNetIncomeOverAssets', finite(current?.cfo) && finite(current?.net_income) && pos(current?.total_assets) ? (current.cfo - current.net_income) / current.total_assets : null);
  const ta = finite(current?.net_income) && finite(current?.cfo) && pos(current?.total_assets) && pos(prior?.total_assets) ? (current.net_income - current.cfo) / ((current.total_assets + prior.total_assets) / 2) : null;
  put('totalAccrualsOverAvgAssets', ta);
  const rg = pos(current?.receivables) && pos(prior?.receivables) && pos(current?.revenue) && pos(prior?.revenue) ? Math.log(current.receivables / prior.receivables) - Math.log(current.revenue / prior.revenue) : null;
  put('receivablesGrowthMinusRevenueGrowth', rg);
  const ig = pos(current?.inventory) && pos(prior?.inventory) && pos(current?.cogs) && pos(prior?.cogs) ? Math.log(current.inventory / prior.inventory) - Math.log(current.cogs / prior.cogs) : null;
  put('inventoryGrowthMinusCogsGrowth', ig);
  const mNow = pos(current?.revenue) && finite(current?.ebitda) ? current.ebitda / current.revenue : null;
  const mh = marginHistory.filter(finite);
  put('marginRobustZ', mNow !== null && mh.length >= 8 ? robustZ(mNow, mh) : null, mh.length < 8 ? 'history<8' : null);
  put('oneOffIncomeShare', finite(oneOffIncome) && finite(current?.net_income) && current.net_income > 0 ? oneOffIncome / current.net_income : null);
  put('relatedPartyRevenueShare', finite(relatedPartyRevenue) && pos(current?.revenue) ? relatedPartyRevenue / current.revenue : null);
  put('debtGrowth', pos(current?.debt) && pos(prior?.debt) ? Math.log(current.debt / prior.debt) : null);
  put('dilution', pos(current?.shares_outstanding) && pos(prior?.shares_outstanding) ? current.shares_outstanding / prior.shares_outstanding - 1 : null);
  ind.auditOpinion = AUDIT_OPINIONS.includes(auditOpinion) ? auditOpinion : null;
  if (ind.auditOpinion === null) unobserved.push('indicator.auditOpinion');
  const b = beneishMScore(current || {}, prior || {});
  const beneish = b.computable ? { M: b.M, indices: b.indices, aboveCutoff: b.aboveCutoff, cutoff: BENEISH.cutoff, calibration: 'UNCALIBRATED_FOR_BIST' } : { M: null, unobserved: b.unobserved, degenerate: !!b.degenerate };
  if (!b.computable) unobserved.push('beneish_m_score');
  const keys = Object.keys(ind);
  return makeResult({
    engine: ENGINE, modelId: 'M33.accounting_quality', status: unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.UNCALIBRATED,
    value: { kind: 'ACCOUNTING_QUALITY_INDICATORS', indicators: ind, beneish, disclaimer: DISCLAIMER }, coverage: coverageOf(keys.length + 1 - unobserved.length, keys.length + 1), unobserved,
    calibration: CALIBRATION.UNCALIBRATED, parameters: { beneish: BENEISH }, notes: [DISCLAIMER],
  });
}
