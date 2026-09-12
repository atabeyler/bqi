import { describe, it, expect } from 'vitest';
import { computeRiskScore, computePriority } from '../src/services/risk.js';

describe('computeRiskScore (pure)', () => {
  it('a KEV-listed, high-CVSS, confirmed finding on a critical asset scores very high', () => {
    const { score } = computeRiskScore({
      cvssScore: 9.8,
      epssScore: 0.9,
      kev: true,
      assetCriticality: 'CRITICAL',
      confidenceScore: 100,
    });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it("spec section 24's worked example: high severity but low confidence must not read as equally risky", () => {
    const highConfidence = computeRiskScore({ cvssScore: 9.7, kev: false, confidenceScore: 99 });
    const lowConfidence = computeRiskScore({ cvssScore: 9.7, kev: false, confidenceScore: 41 });
    expect(lowConfidence.score).toBeLessThan(highConfidence.score);
  });

  it('never goes below 0 or above 100', () => {
    const min = computeRiskScore({ cvssScore: 0, epssScore: 0, kev: false, assetCriticality: 'LOW', confidenceScore: 0 });
    const max = computeRiskScore({ cvssScore: 10, epssScore: 1, kev: true, assetCriticality: 'CRITICAL', confidenceScore: 100 });
    expect(min.score).toBeGreaterThanOrEqual(0);
    expect(max.score).toBeLessThanOrEqual(100);
  });

  it('a finding with no CVSS at all (e.g. a lone SAST hit) still gets a mid-range base score, not zero', () => {
    const { score } = computeRiskScore({ cvssScore: null, confidenceScore: 40 });
    expect(score).toBeGreaterThan(0);
  });

  it('the breakdown carries every input, for explainability', () => {
    const { breakdown } = computeRiskScore({ cvssScore: 7, epssScore: 0.3, kev: false, assetCriticality: 'HIGH', confidenceScore: 80 });
    expect(breakdown).toMatchObject({ cvssScore: 7, epssScore: 0.3, kev: false, assetCriticality: 'HIGH', confidenceScore: 80 });
  });
});

describe('computePriority (pure)', () => {
  it('KEV is always IMMEDIATE regardless of the numeric score', () => {
    expect(computePriority(10, true)).toBe('IMMEDIATE');
  });

  it('maps score bands to the documented priority labels', () => {
    expect(computePriority(95, false)).toBe('IMMEDIATE');
    expect(computePriority(80, false)).toBe('24_HOURS');
    expect(computePriority(60, false)).toBe('HIGH_PRIORITY');
    expect(computePriority(30, false)).toBe('PLANNED');
    expect(computePriority(5, false)).toBe('MONITOR');
  });
});
