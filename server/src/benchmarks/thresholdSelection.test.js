import { describe, expect, it } from 'vitest';
import { selectOrientationAndThreshold, applyOrientation } from './thresholdSelection.js';

describe('selectOrientationAndThreshold', () => {
  it('keeps orientation 1 when the score already correlates with illicit', () => {
    const labels = ['licit', 'licit', 'illicit', 'illicit'];
    const scores = [0.1, 0.2, 0.8, 0.9];
    const selected = selectOrientationAndThreshold(labels, scores);
    expect(selected.orientation).toBe(1);
    expect(selected.metrics.f1).toBe(1);
  });

  it('flips to orientation -1 when the score is anti-correlated with illicit', () => {
    const labels = ['licit', 'licit', 'illicit', 'illicit'];
    const scores = [0.9, 0.8, 0.2, 0.1];
    const selected = selectOrientationAndThreshold(labels, scores);
    expect(selected.orientation).toBe(-1);
    expect(selected.metrics.f1).toBe(1);
  });
});

describe('applyOrientation', () => {
  it('passes scores through unchanged for orientation 1', () => {
    expect(applyOrientation([0.1, 0.9], 1)).toEqual([0.1, 0.9]);
  });

  it('inverts scores for orientation -1', () => {
    const [a, b] = applyOrientation([0.1, 0.9], -1);
    expect(a).toBeCloseTo(0.9);
    expect(b).toBeCloseTo(0.1);
  });
});
