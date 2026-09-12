import crypto from 'node:crypto';

// Application-layer at-rest encryption for sensitive analyses columns
// (title/content), used instead of a native SQLCipher-style whole-database
// driver -- see dbKey.js's comment for why. AES-256-GCM via Node's built-in
// crypto (no native module, so this builds identically on every platform
// electron-builder targets).
//
// Encrypted values are tagged with a version prefix so a value can always
// be told apart from legacy (pre-BQI-002) plaintext -- decryptField() relies
// on this to migrate old rows transparently instead of double-encrypting
// or corrupting them.
const PREFIX = 'aqenc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function keyBuffer(hexKey) {
  return Buffer.from(hexKey, 'hex');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Returns null unchanged (nullable columns), and passes through a value
// that's already encrypted-looking rather than double-wrapping it.
export function encryptField(value, hexKey) {
  if (value === null || value === undefined) return value;
  if (!hexKey) return value; // safeStorage unavailable -- see dbKey.js
  if (isEncrypted(value)) return value;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, keyBuffer(hexKey), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

// Legacy plaintext (no PREFIX) or a null column is returned unchanged --
// this is what makes migration of pre-BQI-002 rows safe: a row that hasn't
// been re-encrypted yet just reads back as its original plaintext until
// the next write (create/update) or the one-time migration pass (see
// migrateExistingRows below) re-saves it through encryptField().
export function decryptField(value, hexKey) {
  if (value === null || value === undefined) return value;
  if (!isEncrypted(value)) return value;
  if (!hexKey) {
    // Encrypted value but no key available (safeStorage became unavailable
    // after the data was encrypted, e.g. a headless Linux box with no
    // secret-service). Fail closed on the field rather than returning
    // ciphertext as if it were readable text.
    throw new Error('field_crypto_keystore_unavailable');
  }

  const rest = value.slice(PREFIX.length);
  const [ivHex, tagHex, dataHex] = rest.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('field_crypto_corrupt');

  const decipher = crypto.createDecipheriv(ALGO, keyBuffer(hexKey), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

// One-time, per-open migration of any pre-BQI-002 plaintext rows still on
// disk into encrypted form. Row-by-row (not a whole-file swap), each row
// update is its own SQLite transaction -- so a crash mid-migration leaves
// some rows encrypted and some still plaintext (safely re-picked up next
// launch) rather than corrupting the database or losing data. No-ops
// entirely when no key is available.
export function migrateExistingRows(db, hexKey) {
  if (!hexKey) return { migrated: 0 };

  const rows = db.prepare('SELECT id, title, content FROM analyses').all();
  let migrated = 0;
  const update = db.prepare('UPDATE analyses SET title = @title, content = @content WHERE id = @id');
  const run = db.transaction((batch) => {
    for (const row of batch) update.run(row);
  });

  const toMigrate = rows
    .filter((r) => !isEncrypted(r.title) || !isEncrypted(r.content))
    .map((r) => ({
      id: r.id,
      title: encryptField(r.title, hexKey),
      content: encryptField(r.content, hexKey),
    }));

  if (toMigrate.length > 0) {
    run(toMigrate);
    migrated = toMigrate.length;
  }
  return { migrated };
}

export const _internal = { PREFIX };
