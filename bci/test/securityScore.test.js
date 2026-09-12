import { describe, it, expect } from 'vitest';
import { computeSecurityScoreFromRiskScores } from '../src/services/securityScore.js';

describe('computeSecurityScoreFromRiskScores (pure)', () => {
  it('no open findings is a perfect 100', () => {
    expect(computeSecurityScoreFromRiskScores([])).toBe(100);
  });

  it('is not a simple average -- a few critical findings hurt more than many low ones', () => {
    const fewCritical = computeSecurityScoreFromRiskScores([95, 92]);
    const manyLow = computeSecurityScoreFromRiskScores(Array(20).fill(10));
    expect(fewCritical).toBeLessThan(manyLow);
  });

  it('never drops below 0', () => {
    const score = computeSecurityScoreFromRiskScores(Array(20).fill(95));
    expect(score).toBe(0);
  });
});
