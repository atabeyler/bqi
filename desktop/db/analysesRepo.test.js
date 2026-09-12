import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { listAnalyses, getAnalysis, createAnalysis, updateAnalysis, deleteAnalysis } from './analysesRepo.js';

let db;
beforeEach(() => { db = createTestDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-WIN-AAAAAAAA';

describe('createAnalysis', () => {
  it('writes the row locally and queues a create operation', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'bddk', title: 'Rapor 1', content: 'içerik' });
    expect(row.version).toBe(1);
    expect(row.syncStatus).toBe('pending');

    const queued = db.prepare('SELECT * FROM sync_queue').all();
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('create');
    expect(queued[0].entity_id).toBe(row.id);
    expect(queued[0].base_version).toBeNull();
  });

  it('is immediately visible offline via listAnalyses/getAnalysis', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'btk', title: 'x', content: 'y' });
    expect(listAnalyses(db, USER).map((r) => r.id)).toContain(row.id);
    expect(getAnalysis(db, USER, row.id)?.title).toBe('x');
  });
});

describe('updateAnalysis', () => {
  it('bumps the local version and queues an update with the pre-edit version as baseVersion', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const updated = updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A2' });

    expect(updated.version).toBe(2);
    expect(updated.title).toBe('A2');

    const queued = db.prepare("SELECT * FROM sync_queue WHERE op = 'update'").all();
    expect(queued).toHaveLength(1);
    expect(queued[0].base_version).toBe(1); // pre-edit version, not the new local version
  });

  it('returns null for a record that does not belong to the user', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    expect(updateAnalysis(db, { userId: 'BOLD-999', deviceId: DEVICE, id: row.id, title: 'hijack' })).toBeNull();
  });
});

describe('deleteAnalysis', () => {
  it('soft-deletes locally (tombstone) and disappears from listAnalyses', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    expect(deleteAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id })).toBe(true);

    expect(listAnalyses(db, USER)).toHaveLength(0);
    expect(getAnalysis(db, USER, row.id)).toBeNull();

    const rawRow = db.prepare('SELECT * FROM analyses WHERE id = ?').get(row.id);
    expect(rawRow.deleted_at).not.toBeNull(); // still on disk as a tombstone, not actually gone
  });
});
