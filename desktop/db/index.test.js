import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, getEncryptionKey } from './index.js';
import { createAnalysis, getAnalysis } from './analysesRepo.js';
import { isEncrypted } from './fieldCrypto.js';

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-db-'));
  return path.join(dir, 'bqi.db');
}

describe('openDatabase — BQI-002 field encryption wiring', () => {
  afterEach(() => closeDatabase());

  it('with no encryptionKey, behaves exactly as before (unencrypted)', () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    expect(getEncryptionKey()).toBeNull();
    const record = createAnalysis(db, { userId: 'u1', deviceId: 'd1', category: 'genel', title: 'T', content: 'C' });
    expect(record.title).toBe('T');

    const raw = db.prepare('SELECT title FROM analyses WHERE id = ?').get(record.id);
    expect(raw.title).toBe('T'); // stored as plaintext when no key
  });

  it('with an encryptionKey, new rows are stored encrypted on disk but read back as plaintext', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });
    const record = createAnalysis(db, { userId: 'u1', deviceId: 'd1', category: 'genel', title: 'Gizli Başlık', content: 'Gizli İçerik' });

    expect(record.title).toBe('Gizli Başlık'); // decrypted via the repo layer
    const raw = db.prepare('SELECT title, content FROM analyses WHERE id = ?').get(record.id);
    expect(isEncrypted(raw.title)).toBe(true);
    expect(raw.title).not.toContain('Gizli Başlık');
  });

  it('migrates a pre-existing plaintext database in place the first time a key becomes available, without data loss', () => {
    const dbPath = tmpDbPath();

    // Simulate a pre-BQI-002 install: open once with no key, write a row.
    let db = openDatabase(dbPath);
    const created = createAnalysis(db, { userId: 'u1', deviceId: 'd1', category: 'genel', title: 'Eski Rapor', content: 'Eski İçerik' });
    closeDatabase();

    // Next launch: safeStorage becomes available (or was already), a key exists.
    const key = crypto.randomBytes(32).toString('hex');
    db = openDatabase(dbPath, { encryptionKey: key });

    const raw = db.prepare('SELECT title, content FROM analyses WHERE id = ?').get(created.id);
    expect(isEncrypted(raw.title)).toBe(true);

    const record = getAnalysis(db, 'u1', created.id);
    expect(record.title).toBe('Eski Rapor');
    expect(record.content).toBe('Eski İçerik');
  });

  it('never crashes or loses the file if the process reopens the same encrypted database', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    let db = openDatabase(dbPath, { encryptionKey: key });
    const created = createAnalysis(db, { userId: 'u1', deviceId: 'd1', category: 'genel', title: 'A', content: 'B' });
    closeDatabase();

    db = openDatabase(dbPath, { encryptionKey: key });
    const record = getAnalysis(db, 'u1', created.id);
    expect(record.title).toBe('A');
  });

  it('the on-disk file is a normal, plain SQLite file (openable with plain better-sqlite3, no native driver change)', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });
    createAnalysis(db, { userId: 'u1', deviceId: 'd1', category: 'genel', title: 'A', content: 'B' });
    closeDatabase();

    // Opening with plain better-sqlite3 and no pragma/key at all must still
    // succeed and read sqlite_master fine -- only the column *values* are
    // encrypted, never the file/database format itself.
    const plain = new Database(dbPath);
    const row = plain.prepare('SELECT count(*) as c FROM analyses').get();
    expect(row.c).toBe(1);
    plain.close();
  });
});
