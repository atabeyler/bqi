import fs from 'node:fs';
import path from 'node:path';

// Wraps Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux) so the JWT never sits in a renderer-reachable
// localStorage. safeStorage is injected rather than imported directly so
// this module (and its logic) can be unit tested outside a running
// Electron process.
export function createSecureStore(userDataDir, safeStorage) {
  const file = path.join(userDataDir, 'session.enc');
  // Used only when the OS keychain/secret-service is unavailable (rare off
  // the Windows target, e.g. some headless Linux setups) -- the session
  // lives for this process only and is never written to disk. A fresh
  // process (the next app launch) always starts with this empty, so it
  // naturally forces online login again rather than silently persisting
  // a plaintext JWT/password hash at rest.
  let memoryOnlySession = null;

  function encryptionAvailable() {
    return !!safeStorage?.isEncryptionAvailable?.();
  }

  function save(value) {
    if (!encryptionAvailable()) {
      memoryOnlySession = value;
      return { persisted: false };
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(value)));
    memoryOnlySession = null;
    return { persisted: true };
  }

  function load() {
    if (!encryptionAvailable()) return memoryOnlySession;
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    try {
      return JSON.parse(safeStorage.decryptString(raw));
    } catch {
      // Also covers a pre-upgrade plaintext session.enc left over from
      // before this fix -- it won't decrypt as ciphertext, so it's
      // discarded rather than read back as plaintext.
      return null;
    }
  }

  function clear() {
    memoryOnlySession = null;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  return { save, load, clear, encryptionAvailable };
}
