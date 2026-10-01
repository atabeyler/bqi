import { describe, it, expect } from 'vitest';
import { runCascade } from '../engines/cascade.js';
import { tailRisk } from '../engines/tailRisk.js';
import { detectAnomalies } from '../engines/anomaly/ensemble.js';
import { Rng } from '../core/prng.js';
import { randomSystem } from './helpers.js';

// Loose upper bounds (CI machines vary); real numbers are recorded in docs/sfre/results/benchmark.json
describe('performance', () => {
  it('cascade: 200 funds x 300 assets within 10s', () => {
    const sys = randomSystem(1, { nFunds: 200, nAssets: 300 });
    const t = Date.now(); const r = runCascade(sys, { priceShocks: { A0: 0.1, A1: 0.1 }, redemptions: { F0: { fraction: 0.4 }, F1: { fraction: 0.4 } } });
    expect(r.value.system.reconciled).toBe(true); expect(Date.now() - t).toBeLessThan(10000);
  });
  it('tail risk: 10k scenarios x 50 assets x 20 funds within 15s', () => {
    const r = new Rng(1); const returns = Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => 0.01 * r.normal()));
    const exposures = Array.from({ length: 20 }, () => Array.from({ length: 50 }, () => 1e6 * r.next()));
    const t = Date.now(); const res = tailRisk({ returns, exposures, fundIds: exposures.map((_, i) => `F${i}`), rng: new Rng(2), N: 10000, B: 30 });
    expect(res.value.methods.bootstrap.systemES).toBeGreaterThan(0); expect(Date.now() - t).toBeLessThan(15000);
  });
  it('anomaly ensemble: 500-point reference within 3s', () => {
    const r = new Rng(1); const ref = Array.from({ length: 500 }, () => r.normal());
    const t = Date.now(); detectAnomalies({ reference: ref, evaluation: [0, 1, 2, 3, 4], seed: 1 }); expect(Date.now() - t).toBeLessThan(3000);
  });
});
