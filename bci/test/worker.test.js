import { describe, it, expect } from 'vitest';
import { decideJobOutcome } from '../src/worker.js';

// Regression coverage for the invariant Wizard step 4 (TARAMA) depends on:
// a job must never be reported COMPLETED when zero engines actually ran,
// whether that's because the plan itself was empty (no coverage for this
// target type) or because every planned engine failed/was SKIPPED during
// execution -- both must resolve to NO_COVERAGE.
describe('decideJobOutcome — a job with zero engines run is never COMPLETED', () => {
  it('is NO_COVERAGE when the plan resolved to zero engines (no target-type coverage)', () => {
    expect(decideJobOutcome({ enginesRun: [], enginesSkipped: [] })).toBe('NO_COVERAGE');
  });

  it('is NO_COVERAGE when every planned engine failed or was skipped', () => {
    expect(decideJobOutcome({
      enginesRun: [],
      enginesSkipped: [{ engineId: 'trivy', reason: 'binary not found' }, { engineId: 'nuclei', reason: 'timeout' }],
    })).toBe('NO_COVERAGE');
  });

  it('is COMPLETED when at least one engine actually ran, even if others failed', () => {
    expect(decideJobOutcome({
      enginesRun: ['nuclei'],
      enginesSkipped: [{ engineId: 'trivy', reason: 'binary not found' }],
    })).toBe('COMPLETED');
  });

  it('is COMPLETED when every planned engine ran', () => {
    expect(decideJobOutcome({ enginesRun: ['trivy', 'nuclei', 'semgrep'], enginesSkipped: [] })).toBe('COMPLETED');
  });
});
