import { describe, expect, it } from 'vitest';
import { binaryMetrics, confusionMatrix, precisionRecallAuc } from './benchmarkMetrics.js';

 describe('benchmarkMetrics', () => {
  it('computes confusion matrix and ignores unknown labels', () => {
    expect(confusionMatrix(
      ['illicit', 'licit', 'illicit', 'licit', 'unknown'],
      ['illicit', 'illicit', 'licit', 'licit', 'illicit']
    )).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
  });

  it('computes binary metrics', () => {
    const m = binaryMetrics(['illicit', 'licit', 'illicit', 'licit'], [0.9, 0.8, 0.7, 0.1], 0.5);
    expect(m.tp).toBe(2);
    expect(m.fp).toBe(1);
    expect(m.tn).toBe(1);
    expect(m.fn).toBe(0);
    expect(m.recall).toBe(1);
    expect(m.precision).toBeCloseTo(2 / 3);
  });

  it('returns perfect PR-AUC for perfect ranking', () => {
    expect(precisionRecallAuc(['illicit', 'illicit', 'licit', 'licit'], [0.9, 0.8, 0.2, 0.1])).toBeCloseTo(1);
  });
});
