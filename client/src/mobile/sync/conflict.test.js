import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { createAnalysis, updateAnalysis, getAnalysis } from '../db/analysesRepo.js';
import { dbGet, dbRun } from '../db/index.js';
import { recordConflict, listUnresolvedConflicts, resolveConflict } from './conflict.js';
import { getDueOperations } from './queue.js';

let db;
beforeEach(async () => { db = await createTestMobileDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-AND-AAAAAAAA';

async function setup() {
  const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'Local başlık', content: 'Local içerik' });
  await dbRun(db, "UPDATE sync_queue SET status = 'done'");
  return updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'Yerel düzenleme' });
}

describe('recordConflict', () => {
  it('marks the local row conflicted and cancels its queued op instead of retrying against a dead baseVersion', async () => {
    const row = await setup();
    await recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel düzenleme' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu düzenleme', content: 'sunucu içerik' }, serverVersion: 2, serverDeleted: false,
    });

    expect((await dbGet(db, 'SELECT sync_status FROM analyses WHERE id = ?', [row.id])).sync_status).toBe('conflict');
    expect(await getDueOperations(db)).toHaveLength(0);

    const conflicts = await listUnresolvedConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].serverVersion).toBe(2);
  });
});

describe('resolveConflict', () => {
  it('kept_server overwrites the local row with the server copy', async () => {
    const row = await setup();
    await recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu kazandı', content: 'sunucu içerik', category: 'x' }, serverVersion: 2, serverDeleted: false,
    });
    const conflictId = (await listUnresolvedConflicts(db))[0].id;

    expect(await resolveConflict(db, { conflictId, deviceId: DEVICE, resolution: 'kept_server' })).toBe(true);
    const final = await getAnalysis(db, USER, row.id);
    expect(final.title).toBe('Sunucu kazandı');
    expect(final.version).toBe(2);
    expect(final.syncStatus).toBe('synced');
    expect(await listUnresolvedConflicts(db)).toHaveLength(0);
  });

  it('kept_local re-queues the local edit against the now-known server version', async () => {
    const row = await setup();
    await recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel kazansın' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu', content: 'x', category: 'x' }, serverVersion: 2, serverDeleted: false,
    });
    const conflictId = (await listUnresolvedConflicts(db))[0].id;

    expect(await resolveConflict(db, { conflictId, deviceId: DEVICE, resolution: 'kept_local' })).toBe(true);

    const due = await getDueOperations(db);
    expect(due).toHaveLength(1);
    expect(due[0].op).toBe('update');
    expect(due[0].base_version).toBe(2);
  });
});
