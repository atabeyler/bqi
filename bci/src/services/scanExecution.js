import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBinary } from '../engines/execFileAsync.js';
import { getAdapter } from '../engines/registry.js';
import { withPentestTransport } from '../pentest/transport.js';

// Some target types need local material on disk before an engine can run
// against them (a REPOSITORY has to be cloned first); others are already
// directly usable as the adapter's `target` argument (a URL, a bare host,
// a CIDR, a container image reference). This is the one seam that knows
// the difference -- adapters themselves stay ignorant of where their input
// came from.
export async function prepareExecutionTarget(targetType, target) {
  if (targetType === 'DOMAIN' || targetType === 'SUBDOMAIN') {
    return { executionTarget: `https://${target}`, cleanup: async () => {} };
  }
  if (targetType !== 'REPOSITORY') {
    return { executionTarget: target, cleanup: async () => {} };
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'bci-scan-'));
  // --depth 1: only the current tree is needed for SAST/SCA/secrets
  // scanning, not history -- smaller, faster, and never touches anything
  // this process doesn't already have read access to clone from.
  await runBinary('git', ['clone', '--depth', '1', '--quiet', target, workDir], { timeoutMs: 120_000 });

  return {
    executionTarget: workDir,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

// Runs one planned engine against the already-prepared execution target and
// returns its raw output, or throws -- the caller (worker.js) is
// responsible for catching per-engine failures so one bad engine doesn't
// abort the whole job.
// engineOptions (optional): this one engine's real per-job execution
// options, e.g. http-fuzz's `{ plan: [...] }` from scan_jobs.engine_options
// (jobQueue.js). Spread last so it can only ever ADD adapter-specific
// fields (plan, authHeader, customHeaders) -- it can never override target/
// mode/capabilities, which always come from the real recommended/selected
// engine plan, not from job-supplied options.
export async function runPlannedEngine(plan, executionTarget, engineOptions, signal, onProgress) {
  const adapter = getAdapter(plan.engineId);
  if (!adapter) throw new Error(`no adapter registered for engine "${plan.engineId}"`);

  const health = await adapter.healthCheck();
  if (health.status !== 'HEALTHY') {
    const err = new Error(`engine "${plan.engineId}" is ${health.status}: ${health.detail || 'unavailable'}`);
    err.skipped = true;
    throw err;
  }

  const adapterTarget = adapter.normalizeExecutionTarget
    ? adapter.normalizeExecutionTarget(executionTarget)
    : executionTarget;
  const execute = () => adapter.execute({ ...(engineOptions || {}), target: adapterTarget, mode: plan.mode, capabilities: plan.capabilities, signal, onProgress });
  const transport = engineOptions?.pentestContext || (engineOptions?.authProfileId ? { engagement: { target: adapterTarget, environment: 'PRODUCTION' } } : null);
  return transport ? withPentestTransport(transport, signal, execute) : execute();
}
