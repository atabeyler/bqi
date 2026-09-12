import { describe, it, expect, afterEach } from 'vitest';
import { getAdapter } from '../src/engines/registry.js';
import { runPlannedEngine } from '../src/services/scanExecution.js';

// spec section 2: an engine that isn't installed must report SKIPPED, never
// be silently absorbed into a job that then looks fully successful.
// Each adapter module captures its binary path once at import time (env
// vars don't change during a running process in real deployment, so this
// is fine in production) -- which means overriding config.engineBins.* at
// test time has no effect. The real, live seam is the registered adapter's
// own healthCheck(), temporarily replaced here and restored after.
describe('runPlannedEngine (spec section 2: engine unavailability is reported, never hidden)', () => {
  const naabuAdapter = getAdapter('naabu');
  const originalHealthCheck = naabuAdapter.healthCheck;
  const originalNaabuExecute = naabuAdapter.execute;
  const fuzzAdapter = getAdapter('http-fuzz');
  const originalFuzzHealthCheck = fuzzAdapter.healthCheck;
  const originalFuzzExecute = fuzzAdapter.execute;

  afterEach(() => {
    naabuAdapter.healthCheck = originalHealthCheck;
    naabuAdapter.execute = originalNaabuExecute;
    fuzzAdapter.healthCheck = originalFuzzHealthCheck;
    fuzzAdapter.execute = originalFuzzExecute;
  });

  it('throws a marked-skipped error (not a generic crash) when the engine reports OFFLINE', async () => {
    naabuAdapter.healthCheck = async () => ({ status: 'OFFLINE', detail: 'binary not found (simulated)' });

    let caught;
    try {
      await runPlannedEngine({ engineId: 'naabu', mode: 'host' }, '10.0.0.1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.skipped).toBe(true);
    expect(caught.message).toMatch(/naabu.*OFFLINE/);
  });

  it('throws a plain (non-skipped) error for an engine id that was never registered at all', async () => {
    await expect(runPlannedEngine({ engineId: 'not-a-real-engine', mode: 'host' }, 'x')).rejects.toThrow(/no adapter registered/);
  });

  it('preserves BCI-native observation metadata envelopes for normalization and result APIs', async () => {
    const envelope = { raw: [{ type: 'HTTP_FUZZ_PROBE' }], discoveryMeta: { endpointsDiscovered: 1 } };
    fuzzAdapter.healthCheck = async () => ({ status: 'HEALTHY' });
    fuzzAdapter.execute = async () => envelope;
    await expect(runPlannedEngine({ engineId: 'http-fuzz', mode: 'web' }, 'https://example.com')).resolves.toEqual(envelope);
  });

  it('passes only the hostname to host-native engines when the shared target is an HTTPS URL', async () => {
    naabuAdapter.healthCheck = async () => ({ status: 'HEALTHY' });
    naabuAdapter.execute = async ({ target }) => target;
    await expect(runPlannedEngine({ engineId: 'naabu', mode: 'host' }, 'https://www.example.com/')).resolves.toBe('www.example.com');
  });
});
