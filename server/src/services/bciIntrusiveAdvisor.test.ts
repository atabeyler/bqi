import { describe, expect, it, vi } from 'vitest';

const generateStructured = vi.fn();
vi.mock('./aiGenerate.js', async () => {
  const actual = await vi.importActual<typeof import('./aiGenerate.js')>('./aiGenerate.js');
  return { ...actual, generateStructured: (...args: unknown[]) => generateStructured(...args) };
});

const { proposeIntrusiveStrategy } = await import('./bciIntrusiveAdvisor.js');

const job = { id: 'scan-1', target: 'https://example.com', target_type: 'URL' };
const implementedModuleIds = ['HTTP_METHOD_PROTOCOL', 'CORS_VALIDATION', 'FINDING_REPRODUCIBILITY_VERIFICATION'];

describe('BCI Smart Intrusive strategy advisor', () => {
  it('proposes no adaptive plan (deterministic, not an error) with zero prior evidence -- BASE runs on its own regardless', async () => {
    const result = await proposeIntrusiveStrategy({
      job, engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 0 }], findings: [], implementedModuleIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('only keeps AI-proposed adaptivePlan entries naming a module BCI can actually run today', async () => {
    generateStructured.mockResolvedValueOnce({
      assessment: {
        summary: 'Reproduce the CORS finding and check TRACE behavior.',
        coverageNarrative: 'The completed engine evidence was assessed.',
        limitations: ['Selected evidence only.'],
        suggestedNextStep: 'Review the proposed validation modules.',
      },
      adaptivePlan: [
        { moduleId: 'FINDING_REPRODUCIBILITY_VERIFICATION', rationale: 'confirm the CORS finding still holds' },
        // Hallucinated / stale -- not in the real, live IMPLEMENTED list supplied.
        { moduleId: 'IDOR_BOLA_VALIDATION', rationale: 'invented, not actually implemented' },
      ],
    });

    const result = await proposeIntrusiveStrategy({
      job,
      engineRuns: [{ engine_id: 'intrusive-validation', status: 'COMPLETED', observation_count: 3 }],
      findings: [{ id: 'f1', title: 'CORS reflects untrusted origin', evidence: { capability: 'INTRUSIVE', module: 'CORS_VALIDATION' } }],
      implementedModuleIds,
      language: 'fr',
    });

    expect(result.source).toBe('ai');
    expect(generateStructured.mock.calls.at(-1)?.[0]).toContain('French');
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.keyEvidence.map((entry) => entry.findingId)).toEqual(['f1']);
    expect(result.adaptivePlan).toHaveLength(1);
    expect(result.adaptivePlan[0].moduleId).toBe('FINDING_REPRODUCIBILITY_VERIFICATION');
  });

  it('falls back to an empty, deterministic adaptivePlan (never blocks BASE Smart Intrusive) when the AI provider is unavailable', async () => {
    generateStructured.mockRejectedValueOnce(new Error('all providers failed'));
    const result = await proposeIntrusiveStrategy({
      job,
      engineRuns: [{ engine_id: 'intrusive-validation', status: 'COMPLETED', observation_count: 3 }],
      findings: [{ id: 'f1', evidence: { capability: 'INTRUSIVE' } }],
      implementedModuleIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
