import { describe, expect, it } from 'vitest';
import { selectConstrainedThreshold } from './constrainedThresholdSelection.js';

const labels = ['illicit', 'illicit', 'licit', 'licit', 'licit'];
const scores = [0.91, 0.61, 0.70, 0.40, 0.10];

describe('selectConstrainedThreshold', () => {
  it('keeps zero false negatives when minRecall is 1', () => {
    const selected = selectConstrainedThreshold(labels, scores, { minRecall: 1, orientations: [1] });
    expect(selected.metrics.fn).toBe(0);
    expect(selected.metrics.recall).toBe(1);
    expect(selected.threshold).toBe(0.61);
    expect(selected.metrics.fp).toBe(1);
  });

  it('raises threshold only when recall constraint permits it', () => {
    const selected = selectConstrainedThreshold(labels, scores, { minRecall: 0.5, orientations: [1] });
    expect(selected.threshold).toBe(0.91);
    expect(selected.metrics.precision).toBe(1);
    expect(selected.metrics.recall).toBe(0.5);
  });

  it('supports inverted orientation with numeric convention', () => {
    const invertedScores = scores.map((score) => 1 - score);
    const selected = selectConstrainedThreshold(labels, invertedScores, { minRecall: 1, orientations: [-1] });
    expect(selected.orientation).toBe(-1);
    expect(selected.metrics.fn).toBe(0);
    expect(selected.threshold).toBeCloseTo(0.61);
  });
});
