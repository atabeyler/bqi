import { describe, expect, it, vi } from 'vitest';

const generateStructured = vi.fn();
vi.mock('./aiGenerate.js', async () => {
  const actual = await vi.importActual<typeof import('./aiGenerate.js')>('./aiGenerate.js');
  return { ...actual, generateStructured: (...args: unknown[]) => generateStructured(...args) };
});

const { proposeFuzzStrategy } = await import('./bciFuzzAdvisor.js');

const job = { id: 'scan-1', target: 'https://example.com', target_type: 'URL' };
const availableCategoryIds = ['SQLI_MARKER', 'BOUNDARY_EMPTY'];

describe('BCI Smart Fuzz strategy advisor', () => {
  it('proposes no adaptive plan (deterministic, not an error) when http-fuzz never ran in this scan -- BASE runs on its own regardless', async () => {
    const result = await proposeFuzzStrategy({
      job, engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 3 }], findings: [], availableCategoryIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('only keeps AI-proposed adaptivePlan entries that name a real (endpoint, parameter) pair from the actual evidence given', async () => {
    generateStructured.mockResolvedValueOnce({
      assessment: {
        summary: 'Deepen testing on the reflected parameter.',
        coverageNarrative: 'The completed http-fuzz round was assessed.',
        limitations: ['Selected FUZZ evidence only.'],
        suggestedNextStep: 'Review and approve the proposed follow-up round.',
      },
      adaptivePlan: [
        // Real -- appears in the fuzzFindings evidence below.
        { method: 'GET', url: 'https://example.com/search', parameter: 'q', location: 'query', categoryId: 'SQLI_MARKER', rationale: 'already reflected once' },
        // Hallucinated -- BCI never reported this endpoint/parameter as evidence.
        { method: 'GET', url: 'https://example.com/admin/delete-everything', parameter: 'confirm', location: 'query', categoryId: 'BOUNDARY_EMPTY', rationale: 'invented' },
      ],
    });

    const result = await proposeFuzzStrategy({
      job,
      engineRuns: [{ engine_id: 'http-fuzz', status: 'COMPLETED', observation_count: 5 }],
      findings: [{
        id: 'f1', title: 'Reflected payload', risk_score: 60, priority: 'HIGH',
        evidence: { capability: 'FUZZ', endpoint: 'https://example.com/search', parameter: 'q' },
      }],
      availableCategoryIds,
      language: 'de',
    });

    expect(result.source).toBe('ai');
    expect(generateStructured.mock.calls.at(-1)?.[0]).toContain('Write every narrative field in German');
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.scopeCovered).toEqual(['http-fuzz']);
    expect(result.keyEvidence.map((entry) => entry.findingId)).toEqual(['f1']);
    expect(result.adaptivePlan).toHaveLength(1);
    expect(result.adaptivePlan[0]).toMatchObject({ url: 'https://example.com/search', parameter: 'q', categoryId: 'SQLI_MARKER' });
  });

  it('falls back to an empty, deterministic adaptivePlan (never blocks BASE Smart Fuzz) when the AI provider is unavailable', async () => {
    generateStructured.mockRejectedValueOnce(new Error('all providers failed'));
    const result = await proposeFuzzStrategy({
      job,
      engineRuns: [{ engine_id: 'http-fuzz', status: 'COMPLETED', observation_count: 5 }],
      findings: [{ id: 'f1', evidence: { capability: 'FUZZ', endpoint: 'https://example.com/search', parameter: 'q' } }],
      availableCategoryIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
