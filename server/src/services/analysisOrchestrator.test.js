import { describe, expect, it } from 'vitest';
import {
  DATA_SOURCE_TYPES,
  RESULT_SOURCE_TYPES,
  resolveDataProvenance,
  resolveResultSource,
  assessDataQuality,
  createDecisionTrace,
  markDecisionStage,
  buildEvidenceSummary,
  runAnalysisStages,
} from './analysisOrchestrator.js';

describe('analysisOrchestrator', () => {
  it('marks structured uploads as verified uploaded provenance', () => {
    const provenance = resolveDataProvenance({ hasRealTransactions: true });
    expect(provenance).toEqual({ type: DATA_SOURCE_TYPES.UPLOADED, source: 'user-upload', verifiedInput: true });
  });

  it('prioritizes an institutional source over uploaded input', () => {
    const provenance = resolveDataProvenance({ hasRealScenarios: true, institutionalSource: 'authorized-feed' });
    expect(provenance.type).toBe(DATA_SOURCE_TYPES.INSTITUTIONAL_API);
    expect(provenance.source).toBe('authorized-feed');
    expect(provenance.verifiedInput).toBe(true);
  });

  it('keeps model-generated input explicitly unverified', () => {
    expect(resolveDataProvenance()).toEqual({
      type: DATA_SOURCE_TYPES.AI_GENERATED,
      source: 'model-generated',
      verifiedInput: false,
    });
  });

  it('scores institutional data higher while applying warning penalties', () => {
    const provenance = resolveDataProvenance({ institutionalSource: 'institution-x' });
    const clean = assessDataQuality({ provenance, recordCount: 100 });
    const warned = assessDataQuality({ provenance, recordCount: 100, warnings: ['a', 'b'] });
    expect(clean.score).toBe(97);
    expect(clean.level).toBe('high');
    expect(warned.score).toBe(90);
    expect(warned.score).toBeLessThan(clean.score);
  });

  it('breaks the score into completeness/freshness/consistency/authority sub-metrics', () => {
    const provenance = resolveDataProvenance({ institutionalSource: 'institution-x' });
    const { metrics } = assessDataQuality({ provenance, recordCount: 100 });
    expect(metrics).toEqual({ completeness: 100, freshness: 90, consistency: 100, authority: 95 });
  });

  it('scores AI-generated (unverified) data lowest across every sub-metric', () => {
    const provenance = resolveDataProvenance();
    const { metrics, level } = assessDataQuality({ provenance });
    expect(metrics.completeness).toBe(50);
    expect(metrics.authority).toBe(50);
    expect(level).toBe('limited');
  });

  it('derives freshness from an explicit asOfDate when provided', () => {
    const provenance = resolveDataProvenance({ hasRealScenarios: true });
    const fresh = assessDataQuality({ provenance, asOfDate: new Date().toISOString() });
    const stale = assessDataQuality({ provenance, asOfDate: new Date(Date.now() - 200 * 86400000).toISOString() });
    expect(fresh.metrics.freshness).toBe(100);
    expect(stale.metrics.freshness).toBe(30);
  });

  it('builds an internal decision trace without requiring user engine choices', () => {
    const provenance = resolveDataProvenance({ hasRealScenarios: true });
    const quality = assessDataQuality({ provenance, recordCount: 3 });
    const trace = createDecisionTrace({ category: 'economy', quantumMode: true, provenance, dataQuality: quality });
    markDecisionStage(trace, 'ai-analysis', 'completed', { provider: 'test' });
    expect(trace.quantumRequested).toBe(true);
    expect(trace.stages.map((s) => s.stage)).toEqual(['ingest', 'validate', 'normalize', 'ai-analysis']);
  });

  it('creates a compact evidence summary', () => {
    const evidence = buildEvidenceSummary({
      provenance: { type: DATA_SOURCE_TYPES.UPLOADED, source: 'user-upload' },
      dataQuality: { score: 85, level: 'high' },
      provider: 'provider-x',
      quantum: { backend: 'qiskit-aer-simulator', shots: 4096, dataSource: 'uploaded' },
    });
    expect(evidence.aiProvider).toBe('provider-x');
    expect(evidence.quantum.shots).toBe(4096);
    expect(evidence.source).toBe(DATA_SOURCE_TYPES.UPLOADED);
  });

  it('labels a missing computation as an AI estimate', () => {
    expect(resolveResultSource(null)).toBe(RESULT_SOURCE_TYPES.AI_ESTIMATE);
  });

  it('labels a plain simulator result as qiskit-aer', () => {
    expect(resolveResultSource({ backend: 'qiskit-aer-simulator' })).toBe(RESULT_SOURCE_TYPES.QISKIT_AER_SIMULATION);
  });

  it('labels a hardwareVerification sub-result as IBM-verified (scenario/fraud shape)', () => {
    expect(resolveResultSource({ backend: 'qiskit-aer-simulator', hardwareVerification: { backend: 'ibm_brisbane' } }))
      .toBe(RESULT_SOURCE_TYPES.IBM_HARDWARE_VERIFIED);
  });

  it('labels a non-simulator backend as IBM-verified (optimizer shape)', () => {
    expect(resolveResultSource({ backend: 'ibm_brisbane' })).toBe(RESULT_SOURCE_TYPES.IBM_HARDWARE_VERIFIED);
  });

  it('runs orchestration stages sequentially and records them', async () => {
    const trace = createDecisionTrace({ category: 'test' });
    const result = await runAnalysisStages(trace, [
      { name: 'first', run: async () => 2 },
      { name: 'second', run: async (results) => results.first * 3 },
    ]);
    expect(result.second).toBe(6);
    expect(trace.stages.at(-1).stage).toBe('second');
    expect(trace.stages.at(-1).status).toBe('completed');
  });
});
