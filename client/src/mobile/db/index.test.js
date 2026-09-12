import { describe, it, expect } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { dbAll, dbGet, dbRun } from './index.js';

describe('openDatabase / migrations', () => {
  it('applies the schema and is idempotent across repeated opens', async () => {
    const db = await createTestMobileDb();
    const tables = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['analyses', 'sync_queue', 'conflicts', 'sync_state', 'device_meta', 'diagnostics_log', '_migrations']));

    const migrations = await dbAll(db, 'SELECT name FROM _migrations');
    expect(migrations).toHaveLength(3); // not re-applied on a second connection
  });

  it('dbRun/dbGet/dbAll round-trip a row', async () => {
    const db = await createTestMobileDb();
    await dbRun(db, `INSERT INTO sync_state (key, value) VALUES ('pull_cursor', '5')`);
    expect((await dbGet(db, `SELECT value FROM sync_state WHERE key = 'pull_cursor'`)).value).toBe('5');
    expect(await dbAll(db, 'SELECT * FROM sync_state')).toHaveLength(1);
  });
});
