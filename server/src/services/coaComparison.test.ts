import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateStructuredMock = vi.fn();
vi.mock('./ai.js', () => ({
  generateStructured: (...args: unknown[]) => generateStructuredMock(...args),
}));

import { generateCoaComparison } from './coaComparison.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeComparison() {
  return {
    options: [
      {
        optionId: 'a', benefit: 'x', cost: 'y', time: 'z', resourceRequirement: 'r',
        legalRegulatoryRisk: 'l', operationalRisk: 'o', secondaryEffects: 's', uncertainty: 'u', evidenceQuality: 'medium',
      },
      {
        optionId: 'b', benefit: 'x2', cost: 'y2', time: 'z2', resourceRequirement: 'r2',
        legalRegulatoryRisk: 'l2', operationalRisk: 'o2', secondaryEffects: 's2', uncertainty: 'u2', evidenceQuality: 'high',
      },
    ],
    aiRecommendation: { optionId: 'b', rationale: 'daha az risk' },
  };
}

describe('generateCoaComparison (BQI-017)', () => {
  it('rejects fewer than 2 options without calling the AI provider', async () => {
    await expect(generateCoaComparison('konu', [{ id: 'a', title: 'A' }])).rejects.toThrow();
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it('returns per-option dimensions plus a separate AI recommendation and a null humanDecision', async () => {
    generateStructuredMock.mockResolvedValueOnce(fakeComparison());
    const result = await generateCoaComparison('konu', [
      { id: 'a', title: 'Seçenek A' },
      { id: 'b', title: 'Seçenek B' },
    ]);

    expect(result.options).toHaveLength(2);
    expect(result.options[0]).toHaveProperty('benefit');
    expect(result.options[0]).toHaveProperty('cost');
    expect(result.options[0]).toHaveProperty('legalRegulatoryRisk');
    expect(result.options[0]).toHaveProperty('operationalRisk');
    expect(result.options[0]).toHaveProperty('secondaryEffects');
    expect(result.options[0]).toHaveProperty('uncertainty');
    expect(result.options[0]).toHaveProperty('evidenceQuality');
    expect(result.aiRecommendation.optionId).toBe('b');
    // The AI recommendation must never be conflated with an actual human
    // decision -- this is the field the task explicitly requires to stay
    // structurally separate.
    expect(result.humanDecision).toBeNull();
  });

  it('passes classification through to generateStructured (same policy path as every other AI call)', async () => {
    generateStructuredMock.mockResolvedValueOnce(fakeComparison());
    await generateCoaComparison('konu', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], 'RESTRICTED');
    const args = generateStructuredMock.mock.calls[0];
    expect(args[3]).toBe('RESTRICTED');
  });
});
