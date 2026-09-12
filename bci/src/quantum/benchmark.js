import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import { query } from '../db/client.js';
import { getQuantumProvider } from './registry.js';
import { resolveExecutionMode } from './executionPolicy.js';
import { COMPUTE_MODES } from './QuantumComputeGateway.js';

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function environmentFingerprint() {
  return createHash('sha256').update(`${process.version}|${os.platform()}|${os.arch()}`).digest('hex').slice(0, 16);
}

async function runProvider(providerId, mode, problem, options) {
  const provider = getQuantumProvider(providerId);
  const startedAt = Date.now();
  try {
    const result = await provider.submitOptimizationProblem(problem, options);
    return { ok: true, mode, providerId, result, wallTimeMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, mode, providerId, error: String(err.message || err), wallTimeMs: Date.now() - startedAt };
  }
}

// BCI Quantum Benchmark Engine (spec section 8): "BCI hiçbir zaman sadece
// 'quantum kullandık' diye quantum sonucu tercih etmemelidir." Always runs
// the classical baseline; runs quantum-inspired unconditionally too (it's
// free/local); only adds the simulator/hardware attempt the execution
// policy actually resolved to.
//
// The verdict is deliberately named QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD
// rather than a bare "QUANTUM_ADVANTAGE" or "QUANTUM_BENEFIT_OBSERVED": one
// knapsack instance beating the classical baseline on objective value is
// not a general scientific claim of quantum advantage, and must never be
// presented as one -- it is a workload-scoped, single-run observation.
// Requires a STRICTLY better feasible objective than the classical
// baseline -- an equal or worse result is NO_QUANTUM_ADVANTAGE_DEMONSTRATED,
// full stop, regardless of which provider produced it.
export async function runBenchmark({ orgId, actorUserId, workloadSource, problem, dataClassification = 'INTERNAL', preferredMode, scanJobId }) {
  const benchmarkId = randomUUID();
  const inputHash = canonicalHash(problem);
  const fingerprint = environmentFingerprint();
  const problemSize = problem.items.length;

  // recommendedDecision is BCI's own suggestion, computed with no
  // preference -- kept separate from `decision` (which honors
  // preferredMode) purely for provenance (spec section 5): recording what
  // BCI would have picked on its own vs. what the caller asked to start
  // from vs. what actually ran, even when all three end up identical.
  const recommendedDecision = preferredMode
    ? await resolveExecutionMode({ orgId, problemSize, dataClassification })
    : null;
  const decision = await resolveExecutionMode({ orgId, problemSize, dataClassification, preferredMode });

  const attempts = [await runProvider('classical', COMPUTE_MODES.CLASSICAL, problem, {})];
  attempts.push(await runProvider('quantum_inspired', COMPUTE_MODES.QUANTUM_INSPIRED, problem, {}));

  if (decision.mode === COMPUTE_MODES.QUANTUM_SIMULATOR) {
    attempts.push(await runProvider('quantum_simulator', COMPUTE_MODES.QUANTUM_SIMULATOR, problem, {}));
  } else if (decision.mode === COMPUTE_MODES.QUANTUM_HARDWARE) {
    attempts.push(await runProvider('ibm_quantum', COMPUTE_MODES.QUANTUM_HARDWARE, problem, {}));
  }

  for (const attempt of attempts) {
    await query(
      `INSERT INTO quantum_jobs (
         org_id, requested_by, benchmark_id, workload_source, algorithm, provider, mode, status,
         qubits, shots, circuit_depth, fallback_reason, result, input_hash, output_hash,
         environment_fingerprint, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())`,
      [
        orgId, actorUserId, benchmarkId, workloadSource,
        attempt.result?.provenance?.algorithm ?? null,
        attempt.providerId, attempt.mode, attempt.ok ? 'COMPLETED' : 'FAILED',
        attempt.result?.provenance?.qubits ?? null,
        attempt.result?.provenance?.shots ?? null,
        attempt.result?.provenance?.circuitDepth ?? null,
        attempt.ok ? null : attempt.error,
        attempt.ok ? JSON.stringify(attempt.result) : null,
        inputHash,
        attempt.ok ? canonicalHash(attempt.result) : null,
        fingerprint,
      ]
    );
  }

  const classicalAttempt = attempts.find((a) => a.providerId === 'classical');
  const classicalValue = classicalAttempt?.ok ? classicalAttempt.result.objectiveValue : null;

  let best = null;
  for (const attempt of attempts) {
    if (!attempt.ok || !attempt.result.feasible) continue;
    if (!best || attempt.result.objectiveValue > best.result.objectiveValue) best = attempt;
  }

  // Strictly greater than the classical baseline -- a tie is NOT an
  // advantage (spec section 8: advantage must be measured, not assumed).
  const verdict =
    best && best.providerId !== 'classical' && classicalValue != null && best.result.objectiveValue > classicalValue
      ? 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD'
      : 'NO_QUANTUM_ADVANTAGE_DEMONSTRATED';

  const results = Object.fromEntries(attempts.map((a) => [a.providerId, a.ok ? { ...a.result, wallTimeMs: a.wallTimeMs } : { error: a.error, wallTimeMs: a.wallTimeMs }]));

  const recommendedMode = recommendedDecision?.mode ?? decision.mode;
  // Only a real divergence between what the user selected and what
  // actually ran counts as a fallback -- no preference given (the
  // pre-existing call shape) never has one.
  const fallbackReason = preferredMode && preferredMode !== decision.mode ? decision.reason : null;

  await query(
    `INSERT INTO quantum_benchmarks (id, org_id, workload_source, results, verdict, scan_job_id, recommended_mode, selected_mode, actual_mode, fallback_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [benchmarkId, orgId, workloadSource, JSON.stringify(results), verdict, scanJobId ?? null, recommendedMode, preferredMode ?? null, decision.mode, fallbackReason]
  );

  return {
    benchmarkId,
    verdict,
    executionMode: decision.mode,
    executionReason: decision.reason,
    recommendedMode,
    selectedMode: preferredMode ?? null,
    actualMode: decision.mode,
    fallbackReason,
    results,
    best: best ? { providerId: best.providerId, mode: best.mode, ...best.result } : null,
  };
}
