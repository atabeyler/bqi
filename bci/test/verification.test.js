import { describe, it, expect } from 'vitest';
import { computeVerificationStatus } from '../src/services/verification.js';

function obs(overrides) {
  return { category: 'SAST', engine_id: 'semgrep', ...overrides };
}

describe('verification engine (pure)', () => {
  it('a live-confirming engine (WEB/API/NETWORK_DISCOVERY) is CONFIRMED even alone', () => {
    expect(computeVerificationStatus([obs({ category: 'WEB', engine_id: 'nuclei' })])).toBe('CONFIRMED');
    expect(computeVerificationStatus([obs({ category: 'NETWORK_DISCOVERY', engine_id: 'naabu' })])).toBe('CONFIRMED');
  });

  it('two distinct engines agreeing on a static finding is CONFIRMED', () => {
    const status = computeVerificationStatus([
      obs({ engine_id: 'semgrep' }),
      obs({ engine_id: 'trivy' }),
    ]);
    expect(status).toBe('CONFIRMED');
  });

  it('a lone secrets-category hit requires manual review, never auto-trusted', () => {
    expect(computeVerificationStatus([obs({ category: 'SECRETS', engine_id: 'trivy' })])).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a single static-analysis source is only LIKELY', () => {
    expect(computeVerificationStatus([obs({ category: 'SCA', engine_id: 'osv-scanner' })])).toBe('LIKELY');
  });

  it('no observations is UNVERIFIED', () => {
    expect(computeVerificationStatus([])).toBe('UNVERIFIED');
  });
});
