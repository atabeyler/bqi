import { describe, it, expect } from 'vitest';
import { breadthAlarm } from '../engines/breadth.js';
import { computeRun, validateRequest } from '../pipeline.js';
import { Rng } from '../core/prng.js';

// synthetic calm universe: each fund has its own noise level; weekly flows are independent small normals
function universe(seed, funds = 120, refWeeks = 40, evWeeks = 10) {
  const r = new Rng(seed); const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r.next()))) * Math.cos(2 * Math.PI * r.next());
  const sig = Array.from({ length: funds }, () => 0.01 + 0.05 * r.next());
  const make = (n) => sig.map((s) => Array.from({ length: n }, () => s * gauss()));
  return { reference: make(refWeeks), evaluation: make(evWeeks), sig };
}

describe('M21 breadth alarm (system-level)', () => {
  it('stays quiet on a calm universe (no fund-level noise is promoted to a system signal)', () => {
    let alarms = 0; for (let s = 1; s <= 20; s++) { const u = universe(s); if (breadthAlarm({ reference: u.reference, evaluation: u.evaluation }).status === 'SIGNAL') alarms++; }
    expect(alarms).toBeLessThanOrEqual(1);
  });
  it('catches a market-wide outflow in which a minority of funds leaves together, in the right week', () => {
    const u = universe(7); const w = 4;
    for (let i = 0; i < 120; i++) if (i % 4 === 0) u.evaluation[i][w] = -8 * u.sig[i] - 0.02; // 25% of funds, far below their own normal
    const r = breadthAlarm({ reference: u.reference, evaluation: u.evaluation });
    expect(r.status).toBe('SIGNAL'); expect(r.value.flaggedWeeks).toEqual([w]);
    expect(r.value.weeks[w].breadth).toBeGreaterThan(r.value.alarmLevel); expect(r.calibration).toBe('UNCALIBRATED');
  });
  it('does not fire when only ONE fund has a huge outflow (the per-fund case)', () => {
    const u = universe(9); u.evaluation[3][2] = -0.9;
    expect(breadthAlarm({ reference: u.reference, evaluation: u.evaluation }).status).toBe('NO_SIGNAL');
  });
  it('declines to answer on too little data and never reads missing values as zero', () => {
    expect(breadthAlarm({ reference: [[0.1]], evaluation: [[0.1]] }).status).toBe('INSUFFICIENT_DATA');
    const u = universe(3); for (let i = 0; i < 120; i++) u.evaluation[i][0] = null;
    const r = breadthAlarm({ reference: u.reference, evaluation: u.evaluation });
    expect(r.value.weeks[0].breadth).toBeNull(); expect(r.unobserved).toContain('week:0');
  });
  it('runs through the pipeline and respects the request size limit', () => {
    const u = universe(11); u.evaluation[0][1] = -1;
    const req = { seed: 1, engines: ['breadth'], breadth: { reference: u.reference, evaluation: u.evaluation } };
    expect(validateRequest(req)).toBeNull();
    const out = computeRun(req, { registryStates: {} });
    expect(out.results.find((x) => x.engine === 'breadth')?.model_id).toBe('M21.breadth');
    expect(validateRequest({ ...req, breadth: { reference: Array.from({ length: 1001 }, () => [0]), evaluation: [[0]] } })).toMatch(/size limits/);
  });
});
