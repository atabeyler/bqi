const PREFIX = 'aqenc:v1:';
const IV_BYTES = 12;

let currentEncryptionKey = null;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function importKey(hexKey) {
  return crypto.subtle.importKey('raw', hexToBytes(hexKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function setEncryptionKey(hexKey) {
  currentEncryptionKey = /^[0-9a-f]{64}$/i.test(hexKey || '') ? hexKey : null;
}

export function getEncryptionKey() {
  return currentEncryptionKey;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export async function encryptField(value, hexKey = currentEncryptionKey) {
  if (value === null || value === undefined) return value;
  if (!hexKey) return value;
  if (isEncrypted(value)) return value;

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(hexKey);
  const encoded = new globalThis.TextEncoder().encode(String(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  return `${PREFIX}${bytesToHex(iv)}:${bytesToHex(encrypted)}`;
}

export async function decryptField(value, hexKey = currentEncryptionKey) {
  if (value === null || value === undefined) return value;
  if (!isEncrypted(value)) return value;
  if (!hexKey) throw new Error('field_crypto_keystore_unavailable');

  const [ivHex, dataHex] = value.slice(PREFIX.length).split(':');
  if (!ivHex || !dataHex) throw new Error('field_crypto_corrupt');

  const key = await importKey(hexKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    key,
    hexToBytes(dataHex)
  );
  return new globalThis.TextDecoder().decode(decrypted);
}

export async function migrateExistingRows(db, { dbAll, dbTransaction } = {}) {
  if (!currentEncryptionKey || !dbAll || !dbTransaction) return { migrated: 0 };

  const rows = await dbAll(db, 'SELECT id, title, content FROM analyses');
  const statements = [];
  for (const row of rows) {
    if (isEncrypted(row.title) && isEncrypted(row.content)) continue;
    statements.push({
      statement: 'UPDATE analyses SET title = ?, content = ? WHERE id = ?',
      values: [
        await encryptField(row.title),
        await encryptField(row.content),
        row.id,
      ],
    });
  }
  if (statements.length) await dbTransaction(db, statements);
  return { migrated: statements.length };
}

export const _internal = { PREFIX, hexToBytes, bytesToHex };
