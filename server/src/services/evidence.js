import { resolveResultSource } from './analysisOrchestrator.js';

/**
 * A-02 (technical audit): the report's core critique was that AI narrative,
 * deterministic/quantum calculation, and uploaded/institutional data sit too
 * close together in a report -- nothing forces "where did this specific
 * number come from" to travel with the number itself. This builds one
 * normalized Evidence Object per claim (the AI narrative, plus each quantum
 * engine's headline result when quantum mode ran), all carrying the same
 * {value, source, method, timestamp, confidence, verified, engine,
 * inputDatasetHash} shape regardless of which engine produced them -- so a
 * caller (report, UI, audit log) can treat every claim in a run uniformly
 * instead of reading engine-specific fields ad hoc.
 */
export function buildEvidenceItems({ provider, quantum, fraud, optimizer, timestamp = new Date().toISOString() } = {}) {
  const items = [];

  items.push({
    claim: 'ai-narrative',
    value: 'report-content',
    source: provider || 'unknown',
    method: 'llm-generation',
    timestamp,
    confidence: null,
    verified: false,
    engine: 'ai',
    inputDatasetHash: null,
  });

  if (quantum) {
    const top = (quantum.scenarios || [])
      .slice()
      .sort((a, b) => (b.quantumProbability ?? 0) - (a.quantumProbability ?? 0))[0];
    items.push({
      claim: 'top-scenario',
      value: top?.id ?? null,
      source: quantum.dataSource || 'ai-generated',
      method: `quantum-mixer-circuit (${quantum.backend || 'unknown'})`,
      timestamp,
      confidence: quantum.classicalBenchmark
        ? (quantum.classicalBenchmark.topScenarioAgrees ? 'agrees-with-classical-baseline' : 'diverges-from-classical-baseline')
        : null,
      verified: resolveResultSource(quantum) === 'ibm_hardware_verified',
      engine: 'scenario-quantum',
      inputDatasetHash: quantum.reproducibility?.inputHash || null,
    });
  }

  if (fraud) {
    items.push({
      claim: 'flagged-transaction-count',
      value: fraud.flaggedCount ?? null,
      source: fraud.dataSource || 'ai-generated',
      method: `quantum-kernel-outlier-detection (${fraud.backend || 'unknown'})`,
      timestamp,
      confidence: fraud.classicalBenchmark ? `${fraud.classicalBenchmark.agreementPercent}% agreement with classical baseline` : null,
      verified: resolveResultSource(fraud) === 'ibm_hardware_verified',
      engine: 'fraud-quantum-kernel',
      inputDatasetHash: fraud.reproducibility?.inputHash || null,
    });
  }

  if (optimizer) {
    items.push({
      claim: 'selected-allocation',
      value: optimizer.selected ?? null,
      source: optimizer.dataSource || 'ai-generated',
      method: `qaoa (${optimizer.backend || 'unknown'})`,
      timestamp,
      confidence: optimizer.classicalBenchmark ? `optimality gap ${optimizer.classicalBenchmark.optimalityGapPercent}%` : null,
      verified: resolveResultSource(optimizer) === 'ibm_hardware_verified',
      engine: 'portfolio-qaoa',
      inputDatasetHash: optimizer.reproducibility?.inputHash || null,
    });
  }

  return items;
}
