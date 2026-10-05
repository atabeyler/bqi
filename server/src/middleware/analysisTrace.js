import {
  assessDataQuality,
  buildEvidenceSummary,
  createDecisionTrace,
  markDecisionStage,
  resolveDataProvenance,
} from '../services/analysisOrchestrator.js';
import crypto from 'crypto';
import {
  classifyData,
  saveDecisionRecord,
} from '../services/decisionIntelligence.js';
import { recordRequestMetric } from '../lib/requestMetrics.js';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// BQI-009 execution fingerprint: a hash per distinct input source that fed
// this analysis (uploaded document, each quantum engine's own dataset),
// so it can later be proven which sources actually produced a given
// report -- distinct from decisionIntelligence.js's input_hash, which
// hashes the whole sanitized request as a single unit.
export function buildSourceHashes(requestBody, body) {
  const hashes = [];
  if (requestBody.documentContext) hashes.push({ source: 'documentContext', hash: sha256(requestBody.documentContext) });
  for (const engine of ['quantum', 'fraud', 'optimizer']) {
    const h = body?.[engine]?.reproducibility?.inputHash;
    if (h) hashes.push({ source: engine, hash: h });
  }
  return hashes;
}

function recordCountFromRequest(body = {}) {
  if (Array.isArray(body.realTransactions)) return body.realTransactions.length;
  if (Array.isArray(body.realScenarios)) return body.realScenarios.length;
  if (Array.isArray(body.realOptimization?.items)) return body.realOptimization.items.length;
  return 0;
}

// Everything needed to reproduce the quantum-mode computations of an
// analysis: per-engine backend/qubit/shot counts and (for the optimizer)
// the COBYLA seed -- see quantum/portfolio_optimizer.py's optimize().
export function buildQuantumParams(body = {}) {
  const params = {};
  if (body.quantum) {
    params.scenario = {
      backend: body.quantum.backend, qubits: body.quantum.qubits,
      shots: body.quantum.shots, batches: body.quantum.batches, circuitDepth: body.quantum.circuitDepth,
    };
  }
  if (body.fraud) {
    params.fraud = { backend: body.fraud.backend, qubits: body.fraud.qubits, circuitDepth: body.fraud.circuitDepth };
  }
  if (body.optimizer) {
    params.optimizer = {
      backend: body.optimizer.backend, qubits: body.optimizer.qubits, circuitDepth: body.optimizer.circuitDepth,
      seed: body.optimizer.seed, qaoaLayers: body.optimizer.qaoaLayers,
    };
  }
  return params;
}

// Snapshots what each engine actually predicted, in a shape that can later
// be compared against a real-world outcome (see computeOutcomeCalibration
// in decisionIntelligence.js) without having to re-parse the full report.
export function buildPredictedOutcome(body = {}) {
  const predicted = {};
  if (Array.isArray(body.scenarios) && body.scenarios.some((s) => s.quantumProbability !== undefined)) {
    predicted.scenario = {
      candidates: body.scenarios
        .filter((s) => s.quantumProbability !== undefined)
        .map((s) => ({ id: s.id, title: s.title, probability: Number(s.quantumProbability) })),
    };
  }
  if (body.fraud?.transactions?.length) {
    predicted.fraud = {
      transactionCount: body.fraud.transactionCount,
      flaggedIds: body.fraud.transactions.filter((t) => t.flagged).map((t) => t.id),
    };
  }
  if (body.optimizer) {
    predicted.optimizer = { totalValue: body.optimizer.totalValue, totalCost: body.optimizer.totalCost, selected: body.optimizer.selected };
  }
  return predicted;
}

function sanitizeRequest(body = {}) {
  return {
    category: body.category || null,
    title: body.title || null,
    prompt: body.prompt || null,
    quantumMode: !!body.quantumMode,
    lang: body.lang || 'tr',
    documentContext: body.documentContext || null,
    realTransactions: body.realTransactions || null,
    realScenarios: body.realScenarios || null,
    realOptimization: body.realOptimization || null,
    dataClassification: body.dataClassification || null,
  };
}

export function analysisTraceMiddleware(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/generate') return next();

  const startedAt = Date.now();
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const durationMs = Date.now() - startedAt;
    recordRequestMetric('analysis.generate', durationMs, res.statusCode || 200);

    if (body?.success) {
      const requestBody = req.body || {};
      const hasRealTransactions = Array.isArray(requestBody.realTransactions) && requestBody.realTransactions.length > 0;
      const hasRealScenarios = Array.isArray(requestBody.realScenarios) && requestBody.realScenarios.length > 0;
      const hasRealOptimization = Array.isArray(requestBody.realOptimization?.items) && requestBody.realOptimization.items.length > 0;
      const provenance = resolveDataProvenance({
        hasUploadedDocument: !!requestBody.documentContext,
        hasRealTransactions,
        hasRealScenarios,
        hasRealOptimization,
        institutionalSource: requestBody.institutionalSource || null,
      });
      const warnings = body.quantumWarning ? [body.quantumWarning] : [];
      const dataQuality = assessDataQuality({
        provenance,
        recordCount: recordCountFromRequest(requestBody),
        warnings,
      });
      const trace = createDecisionTrace({
        category: requestBody.category,
        quantumMode: requestBody.quantumMode,
        provenance,
        dataQuality,
      });
      markDecisionStage(trace, 'research', 'completed');
      markDecisionStage(trace, 'ai-analysis', body.provider ? 'completed' : 'failed', { provider: body.provider || null });
      if (requestBody.quantumMode) {
        markDecisionStage(
          trace,
          'quantum-verification',
          body.quantum || body.fraud || body.optimizer ? 'completed' : 'limited',
          { warning: body.quantumWarning || null }
        );
      }
      markDecisionStage(trace, 'report', 'completed');

      const evidence = buildEvidenceSummary({
        provenance,
        dataQuality,
        provider: body.provider,
        quantum: body.quantum,
        fraud: body.fraud,
        optimizer: body.optimizer,
      });
      const dataClassification = classifyData(requestBody.category, requestBody.dataClassification);
      const replayOf = Number(req.headers['x-bqi-replay-of']) || null;

      // body.provider is the masked "Q CLOUD" label the client sees --
      // decisionIntelligence.js's own ai_provider/model_name audit columns
      // exist specifically to answer "which vendor really produced this,"
      // so this record needs the real one (routes/analysis.js's `_realProvider`
      // field, added to the response body for exactly this purpose). Read
      // it before the field is stripped below so it never reaches the client.
      const realProvider = body._realProvider || body.provider;
      const modelName = body._modelName;

      saveDecisionRecord({
        analysisId: body.analysisId || null,
        replayOf,
        userCode: req.user?.userCode,
        category: requestBody.category,
        title: requestBody.title || requestBody.prompt?.slice(0, 80),
        prompt: requestBody.prompt,
        requestPayload: sanitizeRequest(requestBody),
        provenance,
        dataQuality,
        evidence,
        decisionTrace: trace,
        aiProvider: realProvider,
        modelName,
        dataClassification,
        durationMs,
        quantumParams: buildQuantumParams(body),
        predictedOutcome: buildPredictedOutcome(body),
        sourceHashes: buildSourceHashes(requestBody, body),
      }).catch(() => {});

      if (body._realProvider !== undefined) delete body._realProvider;
      if (body._modelName !== undefined) delete body._modelName;

      body.decisionMeta = {
        source: provenance.type,
        dataQuality: dataQuality.level,
        classification: dataClassification,
        traceRecorded: true,
      };
    }

    return originalJson(body);
  };

  next();
}
