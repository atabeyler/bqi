const STORAGE_KEY = 'aq_device_id';

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Generated once per install and persisted — BQI-AND-XXXXXXXX, per spec
// (matches desktop's BQI-WIN-XXXXXXXX). Just a label, not a secret, so
// plain localStorage is fine (mirrors desktop/auth/deviceId.js's reasoning);
// `storage` is injected for testing.
export function getOrCreateDeviceId(storage = localStorage) {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const deviceId = `BQI-AND-${randomHex(4)}`;
  storage.setItem(STORAGE_KEY, deviceId);
  return deviceId;
}
