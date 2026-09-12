const STORAGE_KEY = 'aq_db_field_key';

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createDbKeyStore(secureStorage) {
  async function getOrCreateKey() {
    if (!secureStorage?.getItem || !secureStorage?.setItem) return null;
    const existing = await secureStorage.getItem(STORAGE_KEY).catch(() => null);
    if (/^[0-9a-f]{64}$/i.test(existing || '')) return existing;

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = bytesToHex(bytes);
    await secureStorage.setItem(STORAGE_KEY, key);
    return key;
  }

  return { getOrCreateKey };
}
