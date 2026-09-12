import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runPlannedEngine: vi.fn(),
  healthCheck: vi.fn(),
  normalizeRaw: vi.fn(),
}));

vi.mock('../src/services/scanExecution.js', () => ({ runPlannedEngine: mocks.runPlannedEngine }));
vi.mock('../src/engines/registry.js', () => ({ getAdapter: () => ({ healthCheck: mocks.healthCheck }) }));
vi.mock('../src/normalization/normalize.js', () => ({ normalizeRaw: mocks.normalizeRaw }));

import { collectLiveControlledProofEvidence } from '../src/controlledProof/liveEngineEvidence.js';

describe('Controlled Proof live engine orchestration', () => {
  beforeEach(() => {
    mocks.runPlannedEngine.mockReset().mockResolvedValue({ raw: [] });
    mocks.healthCheck.mockReset().mockResolvedValue({ status: 'HEALTHY', version: 'test-version' });
    mocks.normalizeRaw.mockReset().mockImplementation((engineId) => [{
      ruleId: `${engineId}-rule`, title: `${engineId} observation`, category: 'WEB', engineSeverity: 'medium',
      verificationStatus: 'VERIFIED', location: 'https://example.com/', evidence: { engineId },
    }]);
  });

  it('executes every bounded existing engine and reports real normalized observations', async () => {
    const result = await collectLiveControlledProofEvidence('https://example.com/');

    expect(mocks.runPlannedEngine).toHaveBeenCalledTimes(4);
    expect(mocks.runPlannedEngine.mock.calls.map(([plan]) => plan.engineId)).toEqual([
      'nuclei', 'http-fuzz', 'intrusive-validation', 'naabu',
    ]);
    expect(mocks.runPlannedEngine.mock.calls[3][1]).toBe('example.com');
    expect(result.executions).toHaveLength(4);
    expect(result.executions.every(({ status, observations, evidenceHash }) => status === 'COMPLETED' && observations === 1 && /^[a-f0-9]{64}$/.test(evidenceHash))).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({ title: 'nuclei observation', category: 'WEB', severity: 'medium', verification_status: 'VERIFIED' });
  });

  it('records an unhealthy engine as skipped instead of fabricating empty successful evidence', async () => {
    mocks.healthCheck.mockResolvedValueOnce({ status: 'OFFLINE', detail: 'binary unavailable' });
    const result = await collectLiveControlledProofEvidence('https://example.com/');

    expect(result.executions[0]).toMatchObject({ engineId: 'nuclei', status: 'SKIPPED', observations: 0, reason: 'binary unavailable' });
    expect(mocks.runPlannedEngine).toHaveBeenCalledTimes(3);
  });
});
