import { describe, it, expect } from 'vitest';
import { getOrCreateDeviceId } from './deviceId.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

describe('getOrCreateDeviceId', () => {
  it('generates an BQI-AND-XXXXXXXX id', () => {
    const id = getOrCreateDeviceId(fakeStorage());
    expect(id).toMatch(/^BQI-AND-[0-9A-F]{8}$/);
  });

  it('is stable across repeated calls (same install)', () => {
    const storage = fakeStorage();
    const first = getOrCreateDeviceId(storage);
    const second = getOrCreateDeviceId(storage);
    expect(second).toBe(first);
  });

  it('generates a different id for a different install', () => {
    const a = getOrCreateDeviceId(fakeStorage());
    const b = getOrCreateDeviceId(fakeStorage());
    expect(a).not.toBe(b);
  });
});
