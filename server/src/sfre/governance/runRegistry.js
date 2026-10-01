import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashOf, sha256 } from '../core/canonical.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function gitCommit() {
  const env = process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA;
  if (env) return env;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'UNKNOWN'; }
}

export function dependencyVersions() {
  let lock = 'UNKNOWN';
  try { lock = sha256(readFileSync(path.join(SERVER_DIR, 'package-lock.json'), 'utf8')); } catch { /* lockfile not present in this deployment */ }
  return { node: process.version, platform: `${process.platform}-${process.arch}`, package_lock_sha256: lock };
}

/**
 * Reproducibility record. run_id and result_hash are content-addressed: same snapshot + models + parameters + seed
 * (+ deterministic engines) => same result_hash. Wall-clock (`started_at`) is metadata and NOT part of any hash.
 */
export function createRunRecord({ snapshot, models, parameters, seed, results, startedAt = new Date().toISOString(), commit = gitCommit(), deps = dependencyVersions() }) {
  const result_hash = hashOf(results.map((r) => r.result_hash));
  const core = {
    git_commit: commit, dataset_snapshot: snapshot ? { id: snapshot.snapshot_id, content_hash: snapshot.content_hash, asOf: snapshot.asOf } : null,
    model_versions: models, parameter_hash: hashOf(parameters), random_seed: seed, dependency_versions: deps, result_hash,
  };
  return Object.freeze({ run_id: `run_${hashOf(core).slice(0, 20)}`, ...core, started_at: startedAt, engine_results: results.map((r) => ({ engine: r.engine, model_id: r.model_id, status: r.status, result_hash: r.result_hash })) });
}
