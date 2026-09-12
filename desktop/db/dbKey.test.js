import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDbKeyStore } from './dbKey.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-dbkey-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) => Buffer.from(str.split('').map((c) => c.charCodeAt(0) ^ 0x5a)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

describe('createDbKeyStore', () => {
  it('generates a 64-char hex (32-byte) key on first call', () => {
    const store = createDbKeyStore(tmpDir(), fakeSafeStorage(true));
    const key = store.getOrCreateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('persists the same key across a fresh store instance (simulating app restart)', () => {
    const dir = tmpDir();
    const key1 = createDbKeyStore(dir, fakeSafeStorage(true)).getOrCreateKey();
    const key2 = createDbKeyStore(dir, fakeSafeStorage(true)).getOrCreateKey();
    expect(key2).toBe(key1);
  });

  it('never writes the raw key to disk', () => {
    const dir = tmpDir();
    createDbKeyStore(dir, fakeSafeStorage(true)).getOrCreateKey();
    const onDisk = fs.readFileSync(path.join(dir, 'db.key.enc'));
    expect(onDisk.toString('latin1')).not.toMatch(/^[0-9a-f]{64}$/i);
  });

  it('returns null (never a hardcoded fallback key) when safeStorage is unavailable', () => {
    const store = createDbKeyStore(tmpDir(), fakeSafeStorage(false));
    expect(store.getOrCreateKey()).toBeNull();
  });

  it('does not persist anything to disk when safeStorage is unavailable', () => {
    const dir = tmpDir();
    createDbKeyStore(dir, fakeSafeStorage(false)).getOrCreateKey();
    expect(fs.existsSync(path.join(dir, 'db.key.enc'))).toBe(false);
  });

  it('generates a fresh key rather than reusing a stored value that fails to decrypt', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'db.key.enc'), 'not-valid-ciphertext');
    const store = createDbKeyStore(dir, fakeSafeStorage(true));
    const key = store.getOrCreateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('encryptionAvailable() reflects the underlying safeStorage state', () => {
    expect(createDbKeyStore(tmpDir(), fakeSafeStorage(true)).encryptionAvailable()).toBe(true);
    expect(createDbKeyStore(tmpDir(), fakeSafeStorage(false)).encryptionAvailable()).toBe(false);
  });
});
