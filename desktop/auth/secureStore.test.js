import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecureStore } from './secureStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-secure-'));
}

// A tiny fake mirroring Electron's safeStorage contract (XOR "encryption"
// is obviously not real security -- it only proves the store round-trips
// through whatever backend it's given rather than doing its own crypto).
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) => Buffer.from(str.split('').map((c) => c.charCodeAt(0) ^ 0x5a)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

describe('createSecureStore', () => {
  it('round-trips a value through the OS-backed encryption', () => {
    const store = createSecureStore(tmpDir(), fakeSafeStorage(true));
    store.save({ jwt: 'secret-token', userCode: 'BOLD-001' });
    expect(store.load()).toEqual({ jwt: 'secret-token', userCode: 'BOLD-001' });
  });

  it('never writes the raw JWT to disk when encryption is available', () => {
    const dir = tmpDir();
    const store = createSecureStore(dir, fakeSafeStorage(true));
    store.save({ jwt: 'super-secret-token' });
    const onDisk = fs.readFileSync(path.join(dir, 'session.enc'), 'utf8');
    expect(onDisk).not.toContain('super-secret-token');
  });

  it('never writes to disk when encryption is unavailable -- keeps the session in memory for this process only', () => {
    const dir = tmpDir();
    const store = createSecureStore(dir, fakeSafeStorage(false));
    const result = store.save({ jwt: 'token' });
    expect(result.persisted).toBe(false);
    expect(store.load()).toEqual({ jwt: 'token' });
    expect(fs.existsSync(path.join(dir, 'session.enc'))).toBe(false);
  });

  it('a fresh store instance (simulating app restart) has no session when encryption was unavailable', () => {
    const dir = tmpDir();
    createSecureStore(dir, fakeSafeStorage(false)).save({ jwt: 'token' });
    const restarted = createSecureStore(dir, fakeSafeStorage(false));
    expect(restarted.load()).toBeNull();
  });

  it('discards a pre-upgrade plaintext session.enc instead of reading it back as valid', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.enc'), JSON.stringify({ jwt: 'leaked-plaintext-token' }));
    const store = createSecureStore(dir, fakeSafeStorage(true));
    expect(store.load()).toBeNull();
  });

  it('encryptionAvailable() reflects the underlying safeStorage state', () => {
    expect(createSecureStore(tmpDir(), fakeSafeStorage(true)).encryptionAvailable()).toBe(true);
    expect(createSecureStore(tmpDir(), fakeSafeStorage(false)).encryptionAvailable()).toBe(false);
  });

  it('returns null when nothing has been saved yet', () => {
    const store = createSecureStore(tmpDir(), fakeSafeStorage(true));
    expect(store.load()).toBeNull();
  });

  it('clear() removes the persisted session', () => {
    const store = createSecureStore(tmpDir(), fakeSafeStorage(true));
    store.save({ jwt: 'x' });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
