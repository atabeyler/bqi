import { describe, it, expect } from 'vitest';
import { evaluateCapability, checkDeviceCapability, ANDROID_MIN_RAM_BYTES } from './deviceCapability.js';

describe('evaluateCapability (Android)', () => {
  it('is capable with a native RAM reading above the threshold', () => {
    const result = evaluateCapability({ totalMemBytes: 8 * 1024 ** 3, freeDiskBytes: 4 * 1024 ** 3 });
    expect(result.capable).toBe(true);
  });

  it('falls back to the deviceMemory bucket when no native reading exists', () => {
    const result = evaluateCapability({ freeDiskBytes: 4 * 1024 ** 3, deviceMemoryHint: 8 });
    expect(result.capable).toBe(true);
  });

  it('fails safe (not capable) when there is no RAM signal at all', () => {
    const result = evaluateCapability({ freeDiskBytes: 4 * 1024 ** 3 });
    expect(result.capable).toBe(false);
    expect(result.reasons).toContain('no_ram_signal');
  });

  it('fails on insufficient RAM even with a signal present', () => {
    const result = evaluateCapability({ totalMemBytes: 2 * 1024 ** 3, freeDiskBytes: 4 * 1024 ** 3 });
    expect(result.capable).toBe(false);
  });

  it('fails on insufficient disk', () => {
    const result = evaluateCapability({ totalMemBytes: ANDROID_MIN_RAM_BYTES + 1, freeDiskBytes: 100 });
    expect(result.capable).toBe(false);
  });
});

describe('checkDeviceCapability', () => {
  it('uses nativeDeviceInfo when provided, ignoring the coarser navigator.deviceMemory bucket', () => {
    const result = checkDeviceCapability({}, {
      nav: { deviceMemory: 2 }, // would fail alone
      nativeDeviceInfo: { totalMemBytes: 12 * 1024 ** 3, freeDiskBytes: 5 * 1024 ** 3 },
    });
    expect(result.capable).toBe(true);
  });

  it('is not capable with no nav and no nativeDeviceInfo', () => {
    const result = checkDeviceCapability({}, { nav: undefined });
    expect(result.capable).toBe(false);
  });
});
