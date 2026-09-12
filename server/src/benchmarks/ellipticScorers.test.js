import { describe, expect, it } from 'vitest';
import { createElliptic5QScorer, createElliptic13QScorer, createRobustClassicalScorer } from './ellipticScorers.js';
import { selectThreshold } from './thresholdSelection.js';

describe('Elliptic scorers', () => {
  const reference = [
    { features: [0, 0, 0, 0, 0] },
    { features: [0.1, -0.1, 0.2, 0, 0.1] },
    { features: [-0.1, 0.1, 0, -0.2, 0] },
  ];

  it('returns bounded scores', async () => {
    const sample = { features: [5, 4, 3, 2, 1] };
    for (const factory of [createRobustClassicalScorer, createElliptic5QScorer, createElliptic13QScorer]) {
      const score = await factory(reference)(sample);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('selects threshold using validation labels/scores', () => {
    const selected = selectThreshold(['licit', 'licit', 'illicit', 'illicit'], [0.1, 0.2, 0.8, 0.9]);
    expect(selected.metrics.f1).toBe(1);
    expect(selected.threshold).toBeGreaterThan(0.2);
    expect(selected.threshold).toBeLessThanOrEqual(0.8);
  });
});
