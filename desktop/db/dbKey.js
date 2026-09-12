import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Manages the local database's at-rest field-encryption key (BQI-002),
// protected by Electron's safeStorage (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) -- the same pattern auth/secureStore.js uses
// to protect the cached login session. The key is generated once (32
// random bytes, suitable for AES-256-GCM) and never written to disk except
// safeStorage-encrypted. safeStorage is injected rather than imported
// directly so this logic is unit-testable outside a running Electron
// process.
//
// A previous attempt at at-rest encryption used a SQLCipher-compatible
// native driver (better-sqlite3-multiple-ciphers) keyed the same way via
// this file -- that was reverted (see git history) because that package
// has no prebuilt binary for this project's Electron/Node ABI on Windows
// or macOS CI runners, so it fell back to a native compile that failed on
// both. This version keeps the exact same key-management design (it was
// never the broken part) but the key protects application-layer field
// encryption (see fieldCrypto.js) instead of a native SQLCipher pragma, so
// the database stays plain better-sqlite3 -- already proven to build on
// all three CI runners with zero native-toolchain setup.
export function createDbKeyStore(userDataDir, safeStorage) {
  const file = path.join(userDataDir, 'db.key.enc');

  function encryptionAvailable() {
    return !!safeStorage?.isEncryptionAvailable?.();
  }

  // Returns a 64-char hex string (a raw 32-byte key) to encrypt sensitive
  // database fields with, or null when safeStorage isn't available on this
  // platform/config.
  //
  // A null return must NOT be treated by callers as "encrypt with some
  // fallback key anyway" -- storing the key in plaintext (env var, disk
  // file, hardcoded) would be worse than no encryption at all, since it
  // creates a false sense of protection. db/index.js's openDatabase()
  // leaves sensitive fields unencrypted when key is null, matching this
  // module's pre-BQI-002 behavior on such platforms.
  function getOrCreateKey() {
    if (!encryptionAvailable()) return null;

    if (fs.existsSync(file)) {
      try {
        const key = safeStorage.decryptString(fs.readFileSync(file));
        if (/^[0-9a-f]{64}$/i.test(key)) return key;
      } catch {
        // Falls through to treating this as "no key file" below. This can
        // happen after an OS keychain reset/migration -- if fields were
        // already encrypted under the now-undecryptable key,
        // fieldCrypto.js's decrypt will itself fail loudly on that
        // mismatch (a corrupt/unreadable field) rather than silently
        // losing data.
      }
    }

    const key = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key));
    return key;
  }

  return { getOrCreateKey, encryptionAvailable };
}
