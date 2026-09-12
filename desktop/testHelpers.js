import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';

// Fresh in-memory SQLite database with the real migrations applied — used
// by every desktop/**/*.test.js file so tests exercise the actual schema
// instead of a hand-rolled stand-in.
export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
