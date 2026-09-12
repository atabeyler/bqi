import { describe, it, expect } from 'vitest';
import { evaluateCapability, checkDeviceCapability, DESKTOP_MIN_RAM_BYTES } from './deviceCapability.js';

describe('evaluateCapability', () => {
  it('is capable with enough RAM/disk/CPU', () => {
    const result = evaluateCapability({ totalMemBytes: 16 * 1024 ** 3, freeDiskBytes: 10 * 1024 ** 3, cpuCount: 8 });
    expect(result.capable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails on insufficient RAM', () => {
    const result = evaluateCapability({ totalMemBytes: 2 * 1024 ** 3, freeDiskBytes: 10 * 1024 ** 3, cpuCount: 8 });
    expect(result.capable).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('insufficient_ram'))).toBe(true);
  });

  it('fails on insufficient disk', () => {
    const result = evaluateCapability({ totalMemBytes: 16 * 1024 ** 3, freeDiskBytes: 1 * 1024 ** 3, cpuCount: 8 });
    expect(result.capable).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('insufficient_disk'))).toBe(true);
  });

  it('fails on insufficient CPU cores', () => {
    const result = evaluateCapability({ totalMemBytes: 16 * 1024 ** 3, freeDiskBytes: 10 * 1024 ** 3, cpuCount: 1 });
    expect(result.capable).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('insufficient_cpu'))).toBe(true);
  });

  it('honors a spec-provided RAM threshold instead of the default', () => {
    const result = evaluateCapability({ totalMemBytes: 5 * 1024 ** 3, freeDiskBytes: 10 * 1024 ** 3, cpuCount: 8 }, { recommendedMinRamBytes: 8 * 1024 ** 3 });
    expect(result.capable).toBe(false);
  });

  it('unknown totalMemBytes is treated as incapable, never as capable', () => {
    const result = evaluateCapability({ totalMemBytes: undefined, freeDiskBytes: 10 * 1024 ** 3, cpuCount: 8 });
    expect(result.capable).toBe(false);
  });
});

describe('checkDeviceCapability (real-hardware wrapper with injected modules)', () => {
  it('reads totalmem/cpus from the injected os module and gates on them', () => {
    const fakeOs = { totalmem: () => DESKTOP_MIN_RAM_BYTES - 1, cpus: () => [{}, {}], tmpdir: () => '/tmp' };
    const fakeFs = { statfsSync: () => ({ bavail: 1000, bsize: 4096 }) };
    const result = checkDeviceCapability({}, { osModule: fakeOs, fsModule: fakeFs, modelsDir: '/tmp/models' });
    expect(result.capable).toBe(false);
  });

  it('degrades gracefully (no disk gate) when statfsSync throws', () => {
    const fakeOs = { totalmem: () => 32 * 1024 ** 3, cpus: () => Array(8).fill({}), tmpdir: () => '/tmp' };
    const fakeFs = { statfsSync: () => { throw new Error('not supported'); } };
    const result = checkDeviceCapability({}, { osModule: fakeOs, fsModule: fakeFs, modelsDir: '/tmp/models' });
    expect(result.capable).toBe(true);
    expect(result.freeDiskBytes).toBeUndefined();
  });
});
