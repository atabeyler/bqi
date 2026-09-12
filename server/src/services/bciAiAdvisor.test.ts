import { describe, expect, it, vi } from 'vitest';

vi.mock('./aiGenerate.js', () => ({
  generateStructuredWithMetadata: vi.fn(async () => ({
    realProvider: 'Test AI',
    object: {
      executiveSummary: 'Evidence-bound executive summary',
      coverageNarrative: 'Only executed coverage was assessed.',
      findingInterpretations: [
        { findingId: 'finding-1', possibleImpact: 'Possible browser policy exposure.', recommendedAction: 'Review header policy.', rationale: 'Supported by observation.', urgency: 'SHORT_TERM' },
        { findingId: 'invented-id', possibleImpact: 'Invented.', recommendedAction: 'Ignore.', rationale: 'No evidence.', urgency: 'IMMEDIATE' },
      ],
      riskSynthesis: { overallAssessment: 'Evidence-bound risk.', relatedFindingIds: ['finding-1', 'invented-id'], possibleCombinedImpact: 'No verified combined impact.', uncertainty: 'Limited to evidence.' },
      actionPlan: [{ order: 1, action: 'Review header policy.', rationale: 'Supported by observation.', relatedFindingIds: ['finding-1', 'invented-id'], urgency: 'SHORT_TERM', requiresUserApproval: true }],
      limitations: ['Selected scope only.'],
      conclusion: 'User decides.',
    },
  })),
}));

const { assessBciScan, deterministicBciAssessment } = await import('./bciAiAdvisor.js');

const job = {
  id: 'scan-1', target: 'example.com', target_type: 'DOMAIN', requested_class: 'SAFE_ACTIVE', status: 'COMPLETED',
  result: {
    recommendedCapabilities: ['WEB', 'FUZZ'], selectedCapabilities: ['WEB'], actualExecutedCapabilities: ['WEB'],
    recommendedEngines: ['nuclei', 'http-fuzz'], selectedEngines: ['nuclei'], enginesRun: ['nuclei'], findingIds: ['finding-1'],
  },
};
const runs = [{ engine_id: 'nuclei', status: 'COMPLETED', observation_count: 1 }];
const findings = [{
  id: 'finding-1', title: 'Missing Content-Security-Policy', risk_score: 31, priority: 'LOW', verification_status: 'OBSERVED',
  sources: [{ engine_id: 'nuclei', capability_id: 'WEB', scan_job_id: 'scan-1', observation_title: 'CSP header missing', evidence: { header: 'content-security-policy' } }],
}];

describe('BCI structured AI advisor', () => {
  it('returns the complete deterministic report contract for zero findings', () => {
    const result = deterministicBciAssessment(job, runs, [], 'tr');
    expect(result.report.verdict).toBe('NO_FINDINGS');
    expect(result.report.executiveSummary).toContain('doğrulanmış bulgu oluşmadı');
    expect(result.report.coverage.actualExecutedEngines).toEqual(['nuclei']);
    expect(result.report.limitations.join(' ')).toContain('tamamen güvenli olduğunu kanıtlamaz');
  });

  it('keeps immutable evidence and removes invented finding references from AI output', async () => {
    const result = await assessBciScan({ job, engineRuns: runs, findings, dataClassification: 'INTERNAL', language: 'en' });
    expect(result).toMatchObject({ source: 'ai', provider: 'Test AI' });
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]).toMatchObject({
      id: 'finding-1', riskScore: 31,
      sources: [{ engineId: 'nuclei', capabilityId: 'WEB', scanJobId: 'scan-1' }],
      interpretation: { possibleImpact: 'Possible browser policy exposure.' },
    });
    expect(result.report.riskSynthesis.relatedFindingIds).toEqual(['finding-1']);
    expect(result.report.actionPlan[0].relatedFindingIds).toEqual(['finding-1']);
    expect(result.report.verdict).toBe('NEEDS_REVIEW');
    expect(result.evidence.findings.some((finding) => finding.id === 'invented-id')).toBe(false);
  });
});
