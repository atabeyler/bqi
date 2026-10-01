import { describe, it, expect } from 'vitest';
import { canonicalJson, hashOf, deepFreeze } from '../core/canonical.js';
import { Rng } from '../core/prng.js';
import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { betaInc, betaQuantile, quantile, median, robustZ, lgamma, poissonSf } from '../core/stats.js';
import { rateInterval, bootstrapCI } from '../engines/uncertainty.js';

describe('canonical hashing', () => {
  it('is key-order independent and stable', () => {
    expect(hashOf({ a: 1, b: [1, 2, { c: 3 }] })).toBe(hashOf({ b: [1, 2, { c: 3 }], a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
  it('rejects non-finite numbers instead of collapsing them to null', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
  it('deepFreeze makes mutation throw in strict mode', () => {
    const o = deepFreeze({ a: { b: 1 } });
    expect(() => { o.a.b = 2; }).toThrow();
  });
});

describe('seeded PRNG', () => {
  it('same seed -> same stream; different seed -> different', () => {
    const a = new Rng(7); const b = new Rng(7); const c = new Rng(8);
    const sa = Array.from({ length: 5 }, () => a.next()); const sb = Array.from({ length: 5 }, () => b.next());
    expect(sa).toEqual(sb);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
  });
  it('normal draws have mean~0 and sd~1', () => {
    const r = new Rng(1); const x = Array.from({ length: 20000 }, () => r.normal());
    const m = x.reduce((s, v) => s + v, 0) / x.length; const v = x.reduce((s, q) => s + (q - m) ** 2, 0) / x.length;
    expect(Math.abs(m)).toBeLessThan(0.03); expect(Math.abs(v - 1)).toBeLessThan(0.05);
  });
  it('child streams are deterministic and independent of draw order', () => {
    const a = new Rng(3); a.next(); a.next();
    const b = new Rng(3);
    expect(a.child('x').next()).toBe(b.child('x').next());
  });
});

describe('result envelope & failure semantics', () => {
  const base = { engine: 'e', modelId: 'm' };
  it('LOW_RISK is impossible with missing data / uncalibrated model', () => {
    expect(() => makeResult({ ...base, status: STATUS.LOW_RISK, coverage: coverageOf(3, 4), calibration: CALIBRATION.CALIBRATED })).toThrow();
    expect(() => makeResult({ ...base, status: STATUS.LOW_RISK, coverage: coverageOf(4, 4), calibration: CALIBRATION.UNCALIBRATED })).toThrow();
    expect(() => makeResult({ ...base, status: STATUS.LOW_RISK, coverage: coverageOf(4, 4), calibration: CALIBRATION.CALIBRATED, unobserved: ['x'] })).toThrow();
    expect(makeResult({ ...base, status: STATUS.LOW_RISK, coverage: coverageOf(4, 4), calibration: CALIBRATION.CALIBRATED }).status).toBe('LOW_RISK');
  });
  it('rejects unknown status and is deeply frozen with a stable hash', () => {
    expect(() => makeResult({ ...base, status: 'FINE' })).toThrow();
    const r = makeResult({ ...base, status: STATUS.MEASURED, value: { a: 1 } });
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(r.result_hash).toBe(makeResult({ ...base, status: STATUS.MEASURED, value: { a: 1 } }).result_hash);
  });
});

describe('numerics', () => {
  it('lgamma / incomplete beta known values', () => {
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(betaInc(0.3, 2, 5)).toBeCloseTo(0.579825, 6);
    expect(betaQuantile(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 8);
  });
  it('quantile / median / robustZ', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(robustZ(10, [1, 2, 3, 4, 5])).toBeCloseTo((10 - 3) / (1.4826 * 1), 8);
    expect(robustZ(1, [2, 2, 2, 2])).toBeNaN(); // zero spread -> undefined, not 0
  });
  it('poisson tail', () => { expect(poissonSf(1, 2)).toBeCloseTo(1 - Math.exp(-2), 10); expect(poissonSf(0, 2)).toBe(1); });
});

describe('uncertainty', () => {
  it('rate interval: rule of three for zero events; unobserved for n=0', () => {
    const z = rateInterval(0, 100);
    expect(z.ruleOfThreeUpper).toBeCloseTo(0.03, 10); expect(z.lo).toBe(0); expect(z.hi).toBeGreaterThan(0.02);
    expect(rateInterval(0, 0).point).toBeNull();
    const m = rateInterval(50, 100); expect(m.lo).toBeLessThan(0.5); expect(m.hi).toBeGreaterThan(0.5);
  });
  it('bootstrap CI is seed-deterministic and brackets the mean', () => {
    const data = Array.from({ length: 200 }, (_, i) => i % 10);
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const a = bootstrapCI(data, mean, new Rng(5)); const b = bootstrapCI(data, mean, new Rng(5));
    expect(a).toEqual(b); expect(a.lo).toBeLessThan(4.5); expect(a.hi).toBeGreaterThan(4.5);
  });
});
