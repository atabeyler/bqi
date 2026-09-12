import migration001 from './migrations/001_init.sql?raw';
import migration002 from './migrations/002_diagnostics.sql?raw';
import migration003 from './migrations/003_offline_lockout.sql?raw';
import { migrateExistingRows } from './fieldCrypto.js';

const DB_NAME = 'bqi';
const MIGRATIONS = [
  ['001_init.sql', migration001],
  ['002_diagnostics.sql', migration002],
  ['003_offline_lockout.sql', migration003],
];

// Opens (creating if needed) the on-device SQLite database via the given
// @capacitor-community/sqlite connection and applies the schema if it
// hasn't been applied yet. `sqlite` is injected (a real SQLiteConnection in
// the app, a fake backed by better-sqlite3 in tests -- see testHelpers.js)
// so this logic never depends on actually running inside a WebView.
export async function openDatabase(sqlite) {
  const { result: alreadyOpen } = await sqlite.isConnection(DB_NAME, false);
  const db = alreadyOpen
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);

  await db.open();
  await runMigrations(db);
  await migrateExistingRows(db, { dbAll, dbTransaction });
  return db;
}

async function runMigrations(db) {
  await db.execute('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set((await dbAll(db, 'SELECT name FROM _migrations')).map((row) => row.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    await db.execute(sql);
    await dbRun(db, 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [name, new Date().toISOString()]);
  }
}

// Thin helpers normalizing the plugin's {values:[...]}/{changes:{...}}
// result shapes to plain arrays/objects -- matching the ergonomics of
// better-sqlite3's .all()/.get()/.run() the desktop app's equivalent code
// uses, so the repo/sync/auth logic ported from desktop/ reads the same way.
export async function dbAll(db, sql, params = []) {
  const res = await db.query(sql, params);
  return res.values || [];
}

export async function dbGet(db, sql, params = []) {
  const rows = await dbAll(db, sql, params);
  return rows[0] || null;
}

export async function dbRun(db, sql, params = []) {
  const res = await db.run(sql, params);
  return res.changes || {};
}

// Runs several statements as one atomic transaction (create/update the
// analyses row + enqueue its sync_queue entry, etc.) -- mirrors
// better-sqlite3's db.transaction() used on desktop.
export async function dbTransaction(db, statements) {
  const res = await db.executeSet(statements, true);
  return res.changes || {};
}
