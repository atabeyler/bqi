import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';

const ENGINE = 'fundamentals';
const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const div = (a, b) => (ok(a) && ok(b) && b !== 0 ? a / b : null);

/**
 * stmt: {period_end, filed_time, revenue, cogs, ebitda, net_income, cfo, capex, total_assets, receivables, inventory,
 *        cash, debt, shares_outstanding, equity}  (null = UNOBSERVED). Caller must pass only statements whose
 * filed_time <= asOf (the PIT view guarantees this); `prev` is the comparable prior-period statement.
 */
export function fundamentalMetrics(stmt, prev = null) {
  const need = ['revenue', 'ebitda', 'net_income', 'cfo', 'capex', 'total_assets', 'cash', 'debt', 'shares_outstanding'];
  const unobserved = need.filter((f) => !ok(stmt?.[f])).map((f) => `statement.${f}`);
  const g = (a, b) => (ok(a) && ok(b) && b > 0 ? a / b - 1 : null);
  const value = {
    ebitdaMargin: div(stmt.ebitda, stmt.revenue),
    netMargin: div(stmt.net_income, stmt.revenue),
    cfoToNetIncome: ok(stmt.net_income) && stmt.net_income > 0 ? div(stmt.cfo, stmt.net_income) : null,
    fcf: ok(stmt.cfo) && ok(stmt.capex) ? stmt.cfo - Math.abs(stmt.capex) : null,
    netDebt: ok(stmt.debt) && ok(stmt.cash) ? stmt.debt - stmt.cash : null,
    netDebtToEbitda: ok(stmt.debt) && ok(stmt.cash) && ok(stmt.ebitda) && stmt.ebitda > 0 ? (stmt.debt - stmt.cash) / stmt.ebitda : null,
    dso: ok(stmt.receivables) && ok(stmt.revenue) && stmt.revenue > 0 ? (stmt.receivables / stmt.revenue) * 365 : null,
    dio: ok(stmt.inventory) && ok(stmt.cogs) && stmt.cogs > 0 ? (stmt.inventory / stmt.cogs) * 365 : null,
    revenueGrowth: prev ? g(stmt.revenue, prev.revenue) : null,
    ebitdaGrowth: prev ? g(stmt.ebitda, prev.ebitda) : null,
    cfoChangeOverAssets: prev && ok(stmt.cfo) && ok(prev.cfo) && ok(stmt.total_assets) && stmt.total_assets > 0 ? (stmt.cfo - prev.cfo) / stmt.total_assets : null,
    netDebtChangeOverAssets: prev && ok(stmt.debt) && ok(stmt.cash) && ok(prev.debt) && ok(prev.cash) && ok(stmt.total_assets) && stmt.total_assets > 0 ? ((stmt.debt - stmt.cash) - (prev.debt - prev.cash)) / stmt.total_assets : null,
    dilution: prev && ok(stmt.shares_outstanding) && ok(prev.shares_outstanding) && prev.shares_outstanding > 0 ? stmt.shares_outstanding / prev.shares_outstanding - 1 : null,
  };
  const nulls = Object.entries(value).filter(([, v]) => v === null).map(([k]) => `metric.${k}`);
  return makeResult({
    engine: ENGINE, modelId: 'M30.fundamentals', status: unobserved.length ? STATUS.INSUFFICIENT_OBSERVABILITY : STATUS.MEASURED,
    value, coverage: coverageOf(need.length - unobserved.length, need.length), unobserved: [...unobserved, ...(unobserved.length ? [] : nulls)],
    calibration: CALIBRATION.UNCALIBRATED, parameters: { filedTime: stmt.filed_time ?? null },
    notes: ['dilution requires split-adjusted share counts', 'metrics that are not meaningful (non-positive denominator) are null, never zero'],
  });
}
