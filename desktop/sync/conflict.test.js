import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { createAnalysis, updateAnalysis, getAnalysis } from '../db/analysesRepo.js';
import { recordConflict, listUnresolvedConflicts, resolveConflict } from './conflict.js';
import { getDueOperations } from './queue.js';

let db;
beforeEach(() => { db = createTestDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-WIN-AAAAAAAA';

function setup() {
  const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'Local başlık', content: 'Local içerik' });
  // Mark the create as already synced (as if a prior sync succeeded), then edit locally.
  db.prepare("UPDATE sync_queue SET status = 'done'").run();
  const updated = updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'Yerel düzenleme' });
  return updated;
}

describe('recordConflict', () => {
  it('marks the local row conflicted and cancels its queued op instead of retrying against a dead baseVersion', () => {
    const row = setup();
    recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel düzenleme' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu düzenleme', content: 'sunucu içerik' }, serverVersion: 2, serverDeleted: false,
    });

    expect(db.prepare('SELECT sync_status FROM analyses WHERE id = ?').get(row.id).sync_status).toBe('conflict');
    expect(getDueOperations(db)).toHaveLength(0); // no longer retried

    const conflicts = listUnresolvedConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].serverVersion).toBe(2);
  });
});

describe('resolveConflict', () => {
  it('kept_server overwrites the local row with the server copy', () => {
    const row = setup();
    recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu kazandı', content: 'sunucu içerik', category: 'x' }, serverVersion: 2, serverDeleted: false,
    });
    const conflictId = listUnresolvedConflicts(db)[0].id;

    expect(resolveConflict(db, { conflictId, deviceId: DEVICE, resolution: 'kept_server' })).toBe(true);
    const final = getAnalysis(db, USER, row.id);
    expect(final.title).toBe('Sunucu kazandı');
    expect(final.version).toBe(2);
    expect(final.syncStatus).toBe('synced');
    expect(listUnresolvedConflicts(db)).toHaveLength(0);
  });

  it('kept_local re-queues the local edit against the now-known server version', () => {
    const row = setup();
    recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: 'Yerel kazansın' }, localBaseVersion: 1,
      serverPayload: { title: 'Sunucu', content: 'x', category: 'x' }, serverVersion: 2, serverDeleted: false,
    });
    const conflictId = listUnresolvedConflicts(db)[0].id;

    expect(resolveConflict(db, { conflictId, deviceId: DEVICE, resolution: 'kept_local' })).toBe(true);

    const due = getDueOperations(db);
    expect(due).toHaveLength(1);
    expect(due[0].op).toBe('update');
    expect(due[0].base_version).toBe(2); // now targets the server's actual current version
  });
});
