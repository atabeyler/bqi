import { describe, expect, it } from 'vitest';
import { advisorFallback, assembleAdvisorAssessment, deriveAdvisorVerdict } from './bciAdvisorAssessment.js';

describe('shared BCI advisor assessment', () => {
  it('derives security verdicts from immutable findings and execution state', () => {
    expect(deriveAdvisorVerdict([], false)).toBe('NO_FINDINGS');
    expect(deriveAdvisorVerdict([{ id: 'f1', priority: 'LOW' }], false)).toBe('NEEDS_REVIEW');
    expect(deriveAdvisorVerdict([], true)).toBe('PARTIAL_COVERAGE');
    expect(deriveAdvisorVerdict([{ id: 'f1', priority: 'IMMEDIATE' }], true)).toBe('CRITICAL');
  });

  it('assembles finding identity, scores and scope from backend facts rather than AI prose', () => {
    const result = assembleAdvisorAssessment({
      findings: [{ id: 'real-finding', title: 'Real finding', risk_score: 75, priority: 'HIGH' }],
      anyEngineFailed: false,
      scopeCovered: ['http-fuzz'],
      narrative: {
        summary: 'Evidence-bound explanation.',
        coverageNarrative: 'A model-authored coverage explanation.',
        limitations: ['Selected evidence only.'],
        suggestedNextStep: 'Review the evidence.',
      },
    });
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.scopeCovered).toEqual(['http-fuzz']);
    expect(result.keyEvidence).toEqual([{ findingId: 'real-finding', title: 'Real finding', riskScore: 75, priority: 'HIGH' }]);
  });

  it('localizes deterministic advisor fallbacks', () => {
    expect(advisorFallback('tr', 'AI_UNAVAILABLE', 'Smart Fuzz').summary).toContain('kullanılamadı');
    expect(advisorFallback('de', 'AI_UNAVAILABLE', 'Smart Fuzz').summary).toContain('nicht verfügbar');
    expect(advisorFallback('unknown', 'AI_UNAVAILABLE', 'Smart Fuzz').summary).toContain('kullanılamadı');
  });
});
