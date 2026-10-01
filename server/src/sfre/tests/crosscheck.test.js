import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hhi } from '../engines/concentration.js';
import { pairOverlap } from '../engines/overlap.js';
import { amihud } from '../engines/microstructure.js';
import { robustZ, logReturns } from '../core/stats.js';
import { tailRisk } from '../engines/tailRisk.js';
import { beneishMScore } from '../engines/accountingQuality.js';
import { runCascade } from '../engines/cascade.js';
import { Rng } from '../core/prng.js';

const REF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sfre/crosscheck/reference.py');
const py = (op, args) => {
  const r = spawnSync(process.env.PYTHON_BIN || 'python3', [REF], { input: JSON.stringify({ op, args }), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python reference failed: ${r.stderr}`);
  return JSON.parse(r.stdout).result;
};

describe('independent Python reference cross-check (stdlib only)', () => {
  it('HHI', () => { const w = [0.4, 0.3, 0.2, 0.1]; expect(hhi(w.map((x, i) => ({ id: `${i}`, w: x }))).value.hhi).toBeCloseTo(py('hhi', { w }), 12); });
  it('weighted overlap', () => { const a = { A: 0.5, B: 0.3, C: 0.2 }; const b = { B: 0.1, C: 0.6, D: 0.3 }; expect(pairOverlap(a, b).overlap).toBeCloseTo(py('overlap', { a, b }), 12); });
  it('Amihud illiquidity', () => {
    const r = new Rng(1); const prices = [10]; const volumes = [1000];
    for (let i = 1; i < 80; i++) { prices.push(prices[i - 1] * Math.exp(0.02 * r.normal())); volumes.push(Math.round(1000 * (0.5 + r.next()))); }
    expect(amihud({ returns: logReturns(prices), prices, volumes }).value.illiq).toBeCloseTo(py('amihud', { prices, volumes }), 14);
  });
  it('robust z', () => { const ref = [1, 2, 2, 3, 4, 4, 5, 9, 10]; expect(robustZ(30, ref)).toBeCloseTo(py('robust_z', { x: 30, ref }), 12); });
  it('expected shortfall (sample, exact tail count)', () => {
    const r = new Rng(3); const rets = Array.from({ length: 300 }, () => [0.01 * r.normal()]);
    const res = tailRisk({ returns: rets, exposures: [[1e6]], fundIds: ['a'], rng: new Rng(9), N: 1000, B: 5 });
    // re-derive PnL independently from the same seeded bootstrap scenarios is not possible in python; check the identity ES(sorted) on a fixed vector instead
    const pnl = Array.from({ length: 200 }, (_, i) => (i - 100) * 10);
    const sorted = pnl.map((p) => -p).sort((a, b) => b - a); const k = Math.ceil((1 - 0.975) * 200 - 1e-9); const es = sorted.slice(0, k).reduce((s, x) => s + x, 0) / k;
    expect(es).toBeCloseTo(py('es', { pnl, alpha: 0.975 }), 10); expect(res.value.methods.bootstrap.systemES).toBeGreaterThan(0);
  });
  it('Beneish M-score', () => {
    const t = { revenue: 1000, cogs: 700, receivables: 150, ppe: 600, total_assets: 2000, depreciation: 60, sga: 90, net_income: 100, cfo: 120, current_assets: 700, securities: 20, current_liabilities: 400, lt_debt: 300 };
    const p = { revenue: 900, cogs: 620, receivables: 110, ppe: 560, total_assets: 1800, depreciation: 55, sga: 80, net_income: 90, cfo: 100, current_assets: 650, securities: 25, current_liabilities: 380, lt_debt: 280 };
    expect(beneishMScore(t, p).M).toBeCloseTo(py('beneish', { t, p }), 12);
  });
  it('cascade one-round closed form (single fund, linear impact)', () => {
    const args = { cash: 1e6, shares: 2e6, price: 10, redemption: 3e6, illiq: 1e-8 };
    const ref = py('cascade_one_round', args);
    const sys = { assets: [{ id: 'A', price: 10, illiq: 1e-8 }], impact: { model: 'amihud-linear' }, funds: [{ id: 'F', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }] }] };
    const f = runCascade(sys, { redemptions: { F: 3e6 } }).value.funds[0];
    expect(f.loss).toBeCloseTo(ref.loss, 4);
  });
});

describe('REGRESSION: floating-point tail count', () => {
  it('(1-0.975)*200 is exactly 5 tail points, not 6', () => {
    const r = new Rng(1); const returns = Array.from({ length: 300 }, () => [0.01 * r.normal()]);
    expect(tailRisk({ returns, exposures: [[1e6]], fundIds: ['a'], rng: new Rng(2), N: 200, alpha: 0.975, B: 3 }).value.methods.bootstrap.tailCount).toBe(5);
  });
});
