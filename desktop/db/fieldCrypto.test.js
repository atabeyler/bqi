import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptField, decryptField, isEncrypted, migrateExistingRows } from './fieldCrypto.js';
import { createTestDb } from '../testHelpers.js';

const KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');

describe('encryptField / decryptField', () => {
  it('round-trips a value', () => {
    const enc = encryptField('gizli rapor içeriği', KEY);
    expect(decryptField(enc, KEY)).toBe('gizli rapor içeriği');
  });

  it('never stores the plaintext inside the encrypted blob', () => {
    const enc = encryptField('super-secret-content', KEY);
    expect(enc).not.toContain('super-secret-content');
  });

  it('passes null/undefined through unchanged', () => {
    expect(encryptField(null, KEY)).toBeNull();
    expect(encryptField(undefined, KEY)).toBeUndefined();
    expect(decryptField(null, KEY)).toBeNull();
  });

  it('returns the value unchanged when no key is available (safeStorage unavailable)', () => {
    expect(encryptField('plain', null)).toBe('plain');
  });

  it('reads back legacy (pre-BQI-002) plaintext unchanged instead of failing', () => {
    expect(decryptField('eski düz metin rapor', KEY)).toBe('eski düz metin rapor');
  });

  it('never double-encrypts an already-encrypted value', () => {
    const enc = encryptField('x', KEY);
    expect(encryptField(enc, KEY)).toBe(enc);
  });

  it('fails closed on a value encrypted under a different key', () => {
    const enc = encryptField('secret', KEY);
    expect(() => decryptField(enc, OTHER_KEY)).toThrow();
  });

  it('throws rather than returning ciphertext when the key becomes unavailable', () => {
    const enc = encryptField('secret', KEY);
    expect(() => decryptField(enc, null)).toThrow();
  });

  it('isEncrypted distinguishes ciphertext from plaintext', () => {
    expect(isEncrypted(encryptField('x', KEY))).toBe(true);
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe('migrateExistingRows', () => {
  it('encrypts pre-existing plaintext rows in place without losing data', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO analyses (id, user_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a1', 'u1', 'd1', 'analysis', 1, 'now', 'now', 'pending', 'genel', 'Başlık', 'İçerik metni')
    `).run();

    const result = migrateExistingRows(db, KEY);
    expect(result.migrated).toBe(1);

    const row = db.prepare('SELECT title, content FROM analyses WHERE id = ?').get('a1');
    expect(isEncrypted(row.title)).toBe(true);
    expect(isEncrypted(row.content)).toBe(true);
    expect(decryptField(row.title, KEY)).toBe('Başlık');
    expect(decryptField(row.content, KEY)).toBe('İçerik metni');
  });

  it('is a no-op (never a partial/corrupt write) when no key is available', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO analyses (id, user_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a1', 'u1', 'd1', 'analysis', 1, 'now', 'now', 'pending', 'genel', 'Başlık', 'İçerik')
    `).run();

    const result = migrateExistingRows(db, null);
    expect(result.migrated).toBe(0);
    const row = db.prepare('SELECT title FROM analyses WHERE id = ?').get('a1');
    expect(row.title).toBe('Başlık');
  });

  it('does not re-encrypt rows already migrated', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO analyses (id, user_id, device_id, type, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a1', 'u1', 'd1', 'analysis', 1, 'now', 'now', 'pending', 'genel', 'Başlık', 'İçerik')
    `).run();

    migrateExistingRows(db, KEY);
    const second = migrateExistingRows(db, KEY);
    expect(second.migrated).toBe(0);
  });
});
