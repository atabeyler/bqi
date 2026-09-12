import { runPlannedEngine } from '../services/scanExecution.js';
import { normalizeRaw } from '../normalization/normalize.js';
import { sha256 } from './core.js';
import { getAdapter } from '../engines/registry.js';

const ENGINE_SPECS = Object.freeze([
  {
    engineId: 'nuclei', capabilities: ['WEB'], mode: 'url',
    options: { scanProfile: 'STANDARD', rateLimit: 5, timeoutMs: 12 * 60_000 },
    target: (url) => url.toString(),
  },
  {
    engineId: 'http-fuzz', capabilities: ['FUZZ'], mode: 'url',
    options: { baseProfile: 'STANDARD', timeoutMs: 30_000 },
    target: (url) => url.toString(),
  },
  {
    engineId: 'intrusive-validation', capabilities: ['INTRUSIVE'], mode: 'url',
    options: { timeoutMs: 30_000 },
    target: (url) => url.toString(),
  },
  {
    engineId: 'naabu', capabilities: ['NETWORK_DISCOVERY'], mode: 'host',
    options: { portProfile: 'TOP_PORTS', rateLimit: 50, timeoutMs: 60_000 },
    target: (url) => url.hostname,
  },
]);

function rowsFromNormalized(engineId, target, normalized) {
  return normalized.map((observation, index) => ({
    id: `live:${engineId}:${index}`,
    engine_id: engineId,
    rule_id: observation.ruleId || null,
    title: observation.title || null,
    category: observation.category || null,
    severity: observation.engineSeverity || observation.severity || null,
    target,
    location: observation.location || null,
    evidence: observation.evidence || {},
    finding_id: null,
    verification_status: observation.verificationStatus || null,
  }));
}

function executionMetrics(raw, normalizedCount) {
  const rawRecords = Array.isArray(raw?.raw) ? raw.raw.length : 0;
  const measuredAttempts = raw?.discoveryMeta?.probesRun ?? raw?.moduleMeta?.attempted;
  const attemptedChecks = Number.isFinite(Number(measuredAttempts)) ? Number(measuredAttempts) : null;
  return { rawRecords, attemptedChecks, normalizedObservations: normalizedCount };
}

// Runs only the existing registered adapters. The fixed plans are bounded,
// system-generated, and contain no user-controlled payload or credential.
// Engine failure is evidence (FAILED/SKIPPED), never a fabricated empty pass.
export async function collectLiveControlledProofEvidence(target, { signal } = {}) {
  const url = new URL(target);
  const rows = [];
  const executions = [];

  for (const spec of ENGINE_SPECS) {
    const startedAt = new Date();
    try {
      const health = await getAdapter(spec.engineId)?.healthCheck();
      if (!health || health.status !== 'HEALTHY') {
        executions.push({
          engineId: spec.engineId, status: 'SKIPPED', version: health?.version || null,
          startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), observations: 0,
          reason: health?.detail || 'engine health check is unavailable',
        });
        continue;
      }
      const raw = await runPlannedEngine(
        { engineId: spec.engineId, capabilities: spec.capabilities, mode: spec.mode },
        spec.target(url), spec.options, signal
      );
      const normalized = normalizeRaw(spec.engineId, raw);
      rows.push(...rowsFromNormalized(spec.engineId, target, normalized));
      executions.push({
        engineId: spec.engineId,
        status: 'COMPLETED',
        version: health.version || null,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        observations: normalized.length,
        ...executionMetrics(raw, normalized.length),
        evidenceHash: sha256(normalized),
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      executions.push({
        engineId: spec.engineId,
        status: error?.skipped ? 'SKIPPED' : 'FAILED',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        observations: 0,
        reason: String(error?.message || error).slice(0, 240),
      });
    }
  }

  return { rows, executions };
}

export const CONTROLLED_PROOF_LIVE_ENGINES = Object.freeze(ENGINE_SPECS.map(({ engineId }) => engineId));
