import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { migrateExistingRows } from './fieldCrypto.js';

let db = null;
let currentEncryptionKey = null;

// Opens (creating if needed) the local SQLite database at dbPath, applies
// any pending migrations, and configures it for a desktop app that may be
// killed mid-write at any time (WAL journaling + a busy timeout instead of
// immediate "database is locked" failures).
//
// `encryptionKey` (a 64-char hex string from db/dbKey.js's getOrCreateKey(),
// or null) enables AES-256-GCM field-level encryption of sensitive columns
// (BQI-002 -- see fieldCrypto.js/analysesRepo.js). Stays plain, unmodified
// better-sqlite3 either way: the database file's own driver/format never
// changes, only how analysesRepo.js reads/writes a few columns.
export function openDatabase(dbPath, { onMigrations, encryptionKey = null } = {}) {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const applied = runMigrations(db);
  onMigrations?.(applied);

  currentEncryptionKey = encryptionKey;
  if (encryptionKey) migrateExistingRows(db, encryptionKey);

  return db;
}

// Read by analysesRepo.js so it doesn't need the key threaded through every
// call site -- module-scoped, matching this file's existing `db` pattern.
export function getEncryptionKey() {
  return currentEncryptionKey;
}

export function getDatabase() {
  if (!db) throw new Error('Database not opened — call openDatabase() first');
  return db;
}

// Test-only: allows each test file to start from a fresh in-memory database
// instead of sharing module-level state.
export function closeDatabase() {
  currentEncryptionKey = null;
  if (db) {
    db.close();
    db = null;
  }
}
