import { describe, expect, it, vi } from 'vitest';

const generateStructured = vi.fn();
vi.mock('./aiGenerate.js', async () => {
  const actual = await vi.importActual<typeof import('./aiGenerate.js')>('./aiGenerate.js');
  return { ...actual, generateStructured: (...args: unknown[]) => generateStructured(...args) };
});

const { proposeResilienceStrategy } = await import('./bciResilienceAdvisor.js');

const job = { id: 'scan-1', target: 'https://example.com', target_type: 'URL' };
const implementedModuleIds = ['CAPACITY', 'RECOVERY', 'RATE_LIMIT'];

describe('BCI Smart Resilience strategy advisor', () => {
  it('proposes no adaptive plan (deterministic, not an error) with zero prior evidence -- BASE runs on its own regardless', async () => {
    const result = await proposeResilienceStrategy({
      job, engineRuns: [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 3 }], findings: [], implementedModuleIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('only keeps AI-proposed adaptivePlan entries naming a module BCI can actually run today', async () => {
    generateStructured.mockResolvedValueOnce({
      assessment: {
        summary: 'Confirm recovery and probe rate-limit again after the saturation signal.',
        coverageNarrative: 'The completed availability-probe round was assessed.',
        limitations: ['Selected resilience evidence only.'],
        suggestedNextStep: 'Review the proposed recovery round.',
      },
      adaptivePlan: [
        { moduleId: 'RECOVERY', rationale: 'confirm recovery after the observed saturation' },
        // Hallucinated / stale -- not in the real, live IMPLEMENTED list supplied.
        { moduleId: 'SOAK_ENDURANCE', rationale: 'invented, not actually implemented' },
      ],
    });

    const result = await proposeResilienceStrategy({
      job,
      engineRuns: [{ engine_id: 'availability-probe', status: 'COMPLETED', observation_count: 5 }],
      findings: [{ id: 'f1', title: 'Capacity saturated under load', evidence: { capability: 'DOS', module: 'CAPACITY', status: 'SATURATED' } }],
      implementedModuleIds,
      language: 'ar',
    });

    expect(result.source).toBe('ai');
    expect(generateStructured.mock.calls.at(-1)?.[0]).toContain('Write every narrative field in Arabic');
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.scopeCovered).toEqual(['availability-probe']);
    expect(result.keyEvidence.map((entry) => entry.findingId)).toEqual(['f1']);
    expect(result.adaptivePlan).toHaveLength(1);
    expect(result.adaptivePlan[0].moduleId).toBe('RECOVERY');
  });

  it('falls back to an empty, deterministic adaptivePlan (never blocks BASE Smart Resilience) when the AI provider is unavailable', async () => {
    generateStructured.mockRejectedValueOnce(new Error('all providers failed'));
    const result = await proposeResilienceStrategy({
      job,
      engineRuns: [{ engine_id: 'availability-probe', status: 'COMPLETED', observation_count: 5 }],
      findings: [{ id: 'f1', evidence: { capability: 'DOS' } }],
      implementedModuleIds,
    });
    expect(result.source).toBe('deterministic');
    expect(result.adaptivePlan).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
