import { describe, it, expect } from 'vitest';
import { createSecureStore } from './secureStore.js';

// A fake mirroring @aparajita/capacitor-secure-storage's contract
// (getItem/setItem/removeItem, Keystore-backed on Android in reality).
function fakeSecureStorage() {
  const map = new Map();
  return {
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
  };
}

describe('createSecureStore', () => {
  it('round-trips a value through the OS-backed encryption', async () => {
    const store = createSecureStore(fakeSecureStorage());
    await store.save({ jwt: 'secret-token', userCode: 'BOLD-001' });
    expect(await store.load()).toEqual({ jwt: 'secret-token', userCode: 'BOLD-001' });
  });

  it('returns null when nothing has been saved yet', async () => {
    const store = createSecureStore(fakeSecureStorage());
    expect(await store.load()).toBeNull();
  });

  it('clear() removes the persisted session', async () => {
    const store = createSecureStore(fakeSecureStorage());
    await store.save({ jwt: 'x' });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
