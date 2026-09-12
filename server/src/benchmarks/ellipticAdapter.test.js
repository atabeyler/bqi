import { describe, expect, it } from 'vitest';
import { adaptEllipticRows, normalizeEllipticLabel } from './ellipticAdapter.js';
import { runBlindAmlBenchmark } from './amlBenchmark.js';

describe('ellipticAdapter', () => {
  it('normalizes official class encoding', () => {
    expect(normalizeEllipticLabel('1')).toBe('illicit');
    expect(normalizeEllipticLabel('2')).toBe('licit');
    expect(normalizeEllipticLabel('unknown')).toBe('unknown');
  });

  it('keeps labels outside model samples', () => {
    const ds = adaptEllipticRows(
      [['tx-a', 0.1, 0.2], ['tx-b', 0.9, 0.8]],
      [['tx-a', '2'], ['tx-b', '1']]
    );
    expect(ds.samples[0]).not.toHaveProperty('label');
    expect(ds.samples[0]).not.toHaveProperty('class');
    expect(ds.labels.get('tx-b')).toBe('illicit');
  });

  it('runs a scorer blind and evaluates only afterwards', async () => {
    const ds = adaptEllipticRows(
      [['a', 0.1], ['b', 0.9]],
      [['a', '2'], ['b', '1']]
    );
    const seen = [];
    const report = await runBlindAmlBenchmark(ds, {
      test: async (sample) => { seen.push(sample); return sample.features[0]; },
    });
    expect(seen.every((sample) => !('label' in sample) && !('class' in sample))).toBe(true);
    expect(report.results.test.metrics.f1).toBe(1);
  });
});
