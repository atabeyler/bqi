const STORAGE_KEY = 'aq_session';

// Wraps the platform secure storage (Android Keystore-backed via
// @aparajita/capacitor-secure-storage) so the JWT/offline-password-hash
// never sits in plain localStorage. `secureStorage` is injected -- the real
// plugin in the app, an in-memory fake in tests -- mirroring
// desktop/auth/secureStore.js's design (there: Electron's safeStorage).
export function createSecureStore(secureStorage) {
  async function save(value) {
    await secureStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  async function load() {
    const raw = await secureStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function clear() {
    await secureStorage.removeItem(STORAGE_KEY);
  }

  return { save, load, clear };
}
