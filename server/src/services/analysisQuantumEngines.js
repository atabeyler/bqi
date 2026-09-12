/**
 * Quantum-mode orchestration for the /generate route: runs the scenario,
 * fraud-kernel and portfolio-optimizer engines against the AI's report (or
 * user-uploaded real data), merges their verification sections into the
 * report content, and schedules the deferred IBM hardware verification
 * lane. Split out of routes/analysis.js, which previously inlined all of
 * this directly in the request handler.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb, isDbConfigured } from '../db/client.js';
import { analyses } from '../db/schema.js';
import {
  computeQuantumProbabilities, mergeQuantumResults,
  isIbmHardwareConfigured, verifyScenarioHardwareAsync, buildScenarioHardwareSection,
} from './quantum.js';
import {
  computeFraudRiskScores, mergeFraudResults,
  verifyFraudHardwareAsync, buildFraudHardwareSection,
} from './fraudDetection.js';
import {
  computeOptimalAllocation, mergeOptimizerResults,
  verifyOptimizerHardwareAsync, buildOptimizerHardwareSection,
} from './portfolioOptimizer.js';
import { broadcastToUser } from './socket.js';
import { enqueueHardwareVerificationJob } from './quantumJobQueue.js';
import { parseScenarios, parseTransactions, parseOptimizationProblem } from './analysisParsers.js';
import { logger } from '../lib/logger.js';

/**
 * Runs the scenario/fraud/optimizer engines for a /generate request and
 * merges their verification sections into the report content.
 *
 * @returns {Promise<{scenarios, quantumComputation, fraudComputation, optimizerComputation,
 *   finalContent: string, quantumWarning: string|null,
 *   hardwareScenarios: Array|null, hardwareTransactions: Array|null}>}
 */
export async function runQuantumEngines({
  quantumMode, fraudCategory, resultContent,
  hasRealTransactions, realTransactions,
  hasRealScenarios, realScenarios,
  hasRealOptimization, realOptimization,
}) {
  let scenarios = quantumMode && !fraudCategory
    ? (hasRealScenarios ? realScenarios : parseScenarios(resultContent))
    : null;
  let quantumComputation = null;
  let fraudComputation = null;
  let optimizerComputation = null;
  let finalContent = resultContent;
  // Surfaced to the client (and appended to the report) whenever quantum
  // mode was requested but the real circuit computation didn't happen --
  // previously this failed completely silently (only a server log line),
  // so a broken Python/Qiskit worker looked identical to a healthy one
  // that just used the AI's own estimates.
  let quantumWarning = null;

  // Hardware verification (when IBM_QUANTUM_TOKEN/INSTANCE are configured)
  // waits on IBM's job queue for up to IBM_QUANTUM_WAIT_SECONDS -- always
  // fetched with skipHardware so /generate responds on the fast local
  // simulator alone; the hardware lane (if any) runs after the response is
  // sent, see scheduleHardwareVerification below.
  let hardwareTransactions = null;
  let hardwareScenarios = null;
  let hardwareOptimization = null;

  if (quantumMode && fraudCategory) {
    const transactions = hasRealTransactions ? realTransactions : parseTransactions(resultContent);
    if (transactions?.length) {
      fraudComputation = await computeFraudRiskScores(transactions, { skipHardware: true });
      if (fraudComputation) {
        hardwareTransactions = transactions;
        fraudComputation.dataSource = hasRealTransactions ? 'uploaded' : 'ai-generated';
        const note = mergeFraudResults(fraudComputation);
        if (note) finalContent += note;
      } else {
        logger.warn('[FraudDetection] Kernel result unavailable — proceeding with AI narrative only');
        quantumWarning = 'Kuantum çekirdek (kernel) hesaplaması başarısız oldu — bu rapor yalnızca YZ anlatısına dayanmaktadır, gerçek kuantum doğrulaması içermemektedir.';
      }
    }
  } else if (quantumMode) {
    if (scenarios?.length) {
      quantumComputation = await computeQuantumProbabilities(scenarios, 4096, { skipHardware: true });
      if (quantumComputation) {
        quantumComputation.dataSource = hasRealScenarios ? 'uploaded' : 'ai-generated';
        const merged = mergeQuantumResults(scenarios, quantumComputation);
        scenarios = merged.scenarios;
        hardwareScenarios = merged.scenarios;
        quantumComputation.classicalBenchmark = merged.classicalBenchmark;
        if (merged.note) finalContent += merged.note;
      } else {
        logger.warn('[Quantum] Circuit result unavailable — proceeding with AI estimates');
        quantumWarning = 'Kuantum devre hesaplaması başarısız oldu — gösterilen olasılıklar YZ tahminleridir, gerçek kuantum ölçümüyle doğrulanmamıştır.';
      }
    } else {
      logger.warn('[Quantum] No parseable scenario matrix in the AI response — quantum computation skipped');
      quantumWarning = 'Kuantum modu seçildi ancak raporda ayrıştırılabilir bir senaryo matrisi bulunamadığından kuantum hesaplaması yapılamadı.';
    }

    // Independent of the scenario matrix: only present when the topic is
    // shaped like a budget-constrained resource-allocation decision, or
    // when the user uploaded one directly.
    const optimizationProblem = hasRealOptimization ? realOptimization : parseOptimizationProblem(resultContent);
    if (optimizationProblem?.items?.length) {
      // skipHardware: true -- the reported selection always comes from the
      // local simulator; a real-hardware verification data point (if
      // configured) is scheduled separately below via scheduleHardwareVerification,
      // exactly like the scenario/fraud engines above.
      optimizerComputation = await computeOptimalAllocation(optimizationProblem.items, optimizationProblem.budgetPercent, { skipHardware: true });
      if (optimizerComputation) {
        optimizerComputation.dataSource = hasRealOptimization ? 'uploaded' : 'ai-generated';
        hardwareOptimization = optimizationProblem;
        const note = mergeOptimizerResults(optimizerComputation);
        if (note) finalContent += note;
      } else {
        logger.warn('[PortfolioOptimizer] QAOA result unavailable — proceeding without it');
      }
    }
  }

  if (quantumWarning) finalContent += `\n\n> ⚠️ ${quantumWarning}`;

  return { scenarios, quantumComputation, fraudComputation, optimizerComputation, finalContent, quantumWarning, hardwareScenarios, hardwareTransactions, hardwareOptimization };
}

export function isHardwareVerificationPending({ hardwareScenarios, hardwareTransactions, hardwareOptimization }) {
  return isIbmHardwareConfigured() && !!(hardwareScenarios || hardwareTransactions || hardwareOptimization);
}

async function appendHardwareSectionToSavedReport(analysisId, finalContent, section) {
  if (!analysisId || !isDbConfigured() || !section) return;
  await getDb().update(analyses)
    .set({
      content: finalContent + section,
      version: sql`${analyses.version} + 1`,
      updatedAt: new Date(),
      syncRevision: sql`nextval('analyses_sync_revision_seq')`,
    })
    .where(eq(analyses.id, analysisId));
}

/**
 * Deferred, non-blocking: the /generate response has already gone out on
 * the fast local-simulator result. If IBM hardware verification is
 * configured, this runs it in the background (this is what can take up to
 * IBM_QUANTUM_WAIT_SECONDS) and, once it resolves, appends the result to
 * the saved report and pushes it to the user's socket if still online.
 *
 * Prefers the persistent job queue (survives a server restart while IBM's
 * hardware queue is still pending — see quantumJobQueue.js), falling back
 * to in-process fire-and-forget processing when DATABASE_URL isn't
 * configured, so non-DB deployments keep working.
 */
export function scheduleHardwareVerification({ io, analysisId, userCode, hardwareScenarios, hardwareTransactions, hardwareOptimization, finalContent }) {
  const kind = hardwareScenarios ? 'scenario' : hardwareTransactions ? 'fraud' : 'optimizer';
  const payload = hardwareScenarios || hardwareTransactions || hardwareOptimization;

  enqueueHardwareVerificationJob({ analysisId, userCode, kind, payload }).then((jobId) => {
    if (jobId) return;
    (async () => {
      try {
        const hw = kind === 'scenario'
          ? await verifyScenarioHardwareAsync(payload)
          : kind === 'fraud'
            ? await verifyFraudHardwareAsync(payload)
            : await verifyOptimizerHardwareAsync(payload.items, payload.budgetPercent);
        if (!hw?.hardwareVerification) return;

        const section = kind === 'scenario'
          ? buildScenarioHardwareSection(payload, hw.hardwareVerification)
          : kind === 'fraud'
            ? buildFraudHardwareSection(hw.hardwareVerification)
            : buildOptimizerHardwareSection(hw.hardwareVerification);
        await appendHardwareSectionToSavedReport(analysisId, finalContent, section);

        broadcastToUser(io, userCode, 'analysis:hardwareVerified', {
          analysisId, kind: kind === 'scenario' ? 'quantum' : kind,
          hardwareVerification: hw.hardwareVerification, ibmDiagnostic: hw.ibmDiagnostic,
        }).catch(() => {});
      } catch (err) {
        logger.warn({ err }, '[Analysis] Background hardware verification failed');
      }
    })();
  });
}
