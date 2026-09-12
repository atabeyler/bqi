import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDatabase } from './helpers/db.js';
import { query } from '../src/db/client.js';
import { listAdapters, runHealthChecks, getEngineStatus } from '../src/engines/registry.js';
import { assertValidAdapter } from '../src/engines/EngineAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAST_FIXTURE = path.join(__dirname, 'fixtures/sast-sample');
const SCA_FIXTURE = path.join(__dirname, 'fixtures/sca-sample');

beforeEach(resetDatabase);

describe('engine registry', () => {
  it('registers all real adapters, each conforming to the adapter contract', () => {
    const adapters = listAdapters();
    const ids = adapters.map((a) => a.id).sort();
    expect(ids).toEqual(['availability-probe', 'bci-posture-intelligence', 'http-fuzz', 'intrusive-validation', 'naabu', 'nuclei', 'osv-scanner', 'semgrep', 'trivy']);
    adapters.forEach((a) => expect(() => assertValidAdapter(a)).not.toThrow());
  });

  // runHealthChecks() spawns all 5 adapters' version-check subprocesses in
  // sequence (each with its own up-to-10s internal timeout) -- vitest's
  // default 5s per-test timeout is too tight for that under real system
  // load, and was previously unset here, making this test spuriously flaky
  // rather than actually broken. Fixing the timeout (not loosening any
  // assertion) is the correct fix, matching the explicit timeouts already
  // used below for the real-engine-execution tests.
  it('healthCheck() never throws, even if a binary is missing (fail visible, not fail crash)', async () => {
    const results = await runHealthChecks();
    expect(results).toHaveLength(9);
    for (const r of results) {
      expect(['HEALTHY', 'DEGRADED', 'OFFLINE']).toContain(r.status);
    }
  }, 60_000);

  it('persists registry + health so GET /api/v1/engines has something to read', async () => {
    await runHealthChecks();
    const status = await getEngineStatus();
    expect(status).toHaveLength(9);
    expect(status.every((e) => e.last_checked_at)).toBe(true);
  }, 60_000);

  it('treats a stale persisted result as UNKNOWN instead of claiming the engine is still healthy', async () => {
    await query(
      `UPDATE engine_health SET status = 'HEALTHY', version = 'stale-version', last_checked_at = now() - interval '1 day'
       WHERE engine_id = 'semgrep'`
    );
    const status = await getEngineStatus();
    const semgrep = status.find((engine) => engine.id === 'semgrep');
    expect(semgrep.status).toBe('UNKNOWN');
    expect(semgrep.stored_status).toBe('HEALTHY');
    expect(semgrep.detail).toMatch(/stale/i);
  });
});

// These exercise the real, locally-installed binaries. They degrade
// gracefully (skip, not fail) when a given engine isn't installed in this
// environment -- CI or a fresh dev machine won't have every scanner
// pre-installed, and that's an OFFLINE engine-health fact (spec section 62),
// not a broken test suite.
async function ifHealthy(id) {
  const adapters = listAdapters();
  const adapter = adapters.find((a) => a.id === id);
  const health = await adapter.healthCheck();
  return { adapter, healthy: health.status === 'HEALTHY' };
}

describe('real engine execution (skips if the binary is not installed)', () => {
  it('Trivy fs-scans a local directory and returns parseable JSON', async () => {
    const { adapter, healthy } = await ifHealthy('trivy');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: SAST_FIXTURE, timeoutMs: 60_000 });
    expect(raw).toBeTypeOf('object');
  }, 60_000);

  it('OSV-Scanner scans a real lockfile and returns parseable JSON', async () => {
    const { adapter, healthy } = await ifHealthy('osv-scanner');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: SCA_FIXTURE, timeoutMs: 60_000 });
    expect(raw).toBeTypeOf('object');
  }, 60_000);

  it('Semgrep scans a real source file and returns parseable JSON', async () => {
    // Not asserting a specific finding count: which rules the `auto`
    // registry config pulls in varies by network/cache state, and pinning
    // this test to "the eval() in the fixture gets flagged" would make it
    // flaky for reasons that have nothing to do with the adapter's own
    // correctness (argv construction, exit-code handling, JSON parsing).
    const { adapter, healthy } = await ifHealthy('semgrep');
    if (!healthy) return;
    const { raw } = await adapter.execute({ target: SAST_FIXTURE, timeoutMs: 90_000 });
    expect(Array.isArray(raw.results)).toBe(true);
    expect(Array.isArray(raw.errors)).toBe(true);
  }, 90_000);
});
