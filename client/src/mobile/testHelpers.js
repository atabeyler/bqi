import Database from 'better-sqlite3';
import { openDatabase } from './db/index.js';
import { setEncryptionKey } from './db/fieldCrypto.js';

// A fake @capacitor-community/sqlite connection backed by a REAL in-memory
// better-sqlite3 database, so mobile/**/*.test.js exercises actual SQL
// execution end to end (not a hand-rolled query-pattern stand-in) while
// production code only ever talks to the real Capacitor plugin's async
// interface. Never imported by production client/ code -- better-sqlite3
// is a native Node module and has no place in a browser/WebView bundle.
function wrapSyncDb(raw) {
  return {
    async open() {},
    async close() { raw.close(); },
    async execute(statements) {
      raw.exec(statements);
      return { changes: { changes: 0 } };
    },
    async query(statement, values = []) {
      const rows = raw.prepare(statement).all(...values);
      return { values: rows };
    },
    async run(statement, values = []) {
      const info = raw.prepare(statement).run(...values);
      return { changes: { changes: info.changes, lastId: info.lastInsertRowid } };
    },
    async executeSet(set) {
      const tx = raw.transaction((statements) => {
        for (const { statement, values } of statements) {
          raw.prepare(statement).run(...(values || []));
        }
      });
      tx(set);
      return { changes: { changes: 0 } };
    },
  };
}

export function createFakeSqliteConnection() {
  const connections = new Map();
  return {
    async isConnection(name) {
      return { result: connections.has(name) };
    },
    async createConnection(name) {
      const raw = new Database(':memory:');
      raw.pragma('foreign_keys = ON');
      const wrapped = wrapSyncDb(raw);
      connections.set(name, wrapped);
      return wrapped;
    },
    async retrieveConnection(name) {
      return connections.get(name);
    },
    async closeConnection(name) {
      connections.delete(name);
    },
  };
}

// Fresh, migrated database for a single test -- mirrors
// desktop/testHelpers.js's createTestDb().
export async function createTestMobileDb() {
  setEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  return openDatabase(createFakeSqliteConnection());
}
