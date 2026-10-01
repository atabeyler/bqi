// SFRE performance benchmark: real wall-clock numbers on the machine it runs on.
// Usage: node scripts/sfre-benchmark.js  -> prints JSON and writes docs/sfre/results/benchmark.json
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCascade } from '../src/sfre/engines/cascade.js';
import { tailRisk } from '../src/sfre/engines/tailRisk.js';
import { detectAnomalies } from '../src/sfre/engines/anomaly/ensemble.js';
import { reverseStress } from '../src/sfre/engines/reverseStress.js';
import { generateWorld } from '../src/sfre/validation/syntheticWorld.js';
import { Rng } from '../src/sfre/core/prng.js';
import { randomSystem } from '../src/sfre/tests/helpers.js';

const time = (fn, reps = 3) => { const t = []; let out; for (let i = 0; i < reps; i++) { const s = process.hrtime.bigint(); out = fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); } t.sort((a, b) => a - b); return { medianMs: Math.round(t[Math.floor(t.length / 2)] * 10) / 10, minMs: Math.round(t[0] * 10) / 10, maxMs: Math.round(t[t.length - 1] * 10) / 10, out }; };
const rows = [];
const add = (name, params, r, extra = {}) => { rows.push({ name, params, medianMs: r.medianMs, minMs: r.minMs, maxMs: r.maxMs, ...extra }); console.log(name, JSON.stringify(params), `${r.medianMs}ms`); };

for (const [nF, nA] of [[50, 100], [200, 300], [1000, 1000]]) {
  const sys = randomSystem(1, { nFunds: nF, nAssets: nA });
  const r = time(() => runCascade(sys, { priceShocks: { A0: 0.1, A1: 0.1 }, redemptions: { F0: { fraction: 0.4 }, F1: { fraction: 0.4 } } }), nF >= 1000 ? 1 : 3);
  add('cascade', { funds: nF, assets: nA }, r, { rounds: r.out.value.rounds.length, reconciled: r.out.value.system.reconciled });
}
{
  const g = new Rng(1); const returns = Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => 0.01 * g.normal())); const exposures = Array.from({ length: 20 }, () => Array.from({ length: 50 }, () => 1e6 * g.next()));
  for (const N of [10000, 100000]) add('tailRisk', { scenarios: N, assets: 50, funds: 20, methods: 2 }, time(() => tailRisk({ returns, exposures, fundIds: exposures.map((_, i) => `F${i}`), rng: new Rng(2), N, B: 50 }), 1));
}
{
  const g = new Rng(1); const ref = Array.from({ length: 500 }, () => g.normal());
  add('anomalyEnsemble(6 detectors)', { reference: 500, evaluation: 5 }, time(() => detectAnomalies({ reference: ref, evaluation: [0, 1, 2, 3, 4], seed: 1 })));
}
{
  const sys = randomSystem(12, { nFunds: 20, nAssets: 20, withClaims: false }); const ids = sys.assets.map((a) => a.id); const g = new Rng(5); const returns = Array.from({ length: 300 }, () => ids.map(() => 0.02 * g.normal()));
  const r = time(() => reverseStress({ system: sys, shockAssets: ids, returns, criterion: { metric: 'lossFraction', threshold: 0.2 }, rng: new Rng(1) }), 1);
  add('reverseStress (default budget 12 starts+40 local, 28 bisect)', { funds: 20, assets: 20 }, r, { evaluations: r.out.value?.evaluations });
}
{
  const s = process.hrtime.bigint(); const w = generateWorld({ seed: 1 }); const gen = Number(process.hrtime.bigint() - s) / 1e6;
  add('syntheticWorld generation (hash-verified PIT ingestion)', { observations: w.store.size }, { medianMs: Math.round(gen), minMs: Math.round(gen), maxMs: Math.round(gen) });
  const s2 = process.hrtime.bigint(); w.store.asOf(w.startMs + 400 * 86400000); add('PitStore.asOf', { observations: w.store.size }, { medianMs: Number(process.hrtime.bigint() - s2) / 1e6, minMs: 0, maxMs: 0 });
}
const out = { machine: { node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, platform: `${process.platform}-${process.arch}` }, note: 'single-threaded, synchronous JS on the API thread; wall-clock', rows };
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/sfre/results'); mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'benchmark.json'), `${JSON.stringify(out, null, 2)}\n`);
