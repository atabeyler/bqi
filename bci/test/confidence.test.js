import { describe, it, expect } from 'vitest';
import { computeConfidenceScore } from '../src/services/confidence.js';

function obs(overrides) {
  return { engine_id: 'semgrep', cvss_score: null, ...overrides };
}

describe('confidence engine (pure)', () => {
  it('zero observations is zero confidence', () => {
    expect(computeConfidenceScore([], 'UNVERIFIED')).toBe(0);
  });

  it('more distinct engines agreeing raises the base score', () => {
    const one = computeConfidenceScore([obs({ engine_id: 'semgrep' })], 'LIKELY');
    const two = computeConfidenceScore([obs({ engine_id: 'semgrep' }), obs({ engine_id: 'trivy' })], 'CONFIRMED');
    const three = computeConfidenceScore(
      [obs({ engine_id: 'semgrep' }), obs({ engine_id: 'trivy' }), obs({ engine_id: 'osv-scanner' })],
      'CONFIRMED'
    );
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(three);
  });

  it('CONFIRMED verification adds on top of the source-count base', () => {
    const likely = computeConfidenceScore([obs({}), obs({ engine_id: 'trivy' })], 'LIKELY');
    const confirmed = computeConfidenceScore([obs({}), obs({ engine_id: 'trivy' })], 'CONFIRMED');
    expect(confirmed).toBeGreaterThan(likely);
  });

  it('a concrete CVSS score adds a small bump', () => {
    const withoutCvss = computeConfidenceScore([obs({ cvss_score: null })], 'LIKELY');
    const withCvss = computeConfidenceScore([obs({ cvss_score: 9.1 })], 'LIKELY');
    expect(withCvss).toBeGreaterThan(withoutCvss);
  });

  it('MANUAL_REVIEW_REQUIRED is capped even with several sources', () => {
    const score = computeConfidenceScore(
      [obs({ engine_id: 'a' }), obs({ engine_id: 'b' }), obs({ engine_id: 'c' })],
      'MANUAL_REVIEW_REQUIRED'
    );
    expect(score).toBeLessThanOrEqual(50);
  });

  it('never exceeds 100 or drops below 0', () => {
    const score = computeConfidenceScore(
      [obs({ engine_id: 'a', cvss_score: 10 }), obs({ engine_id: 'b' }), obs({ engine_id: 'c' })],
      'CONFIRMED'
    );
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
