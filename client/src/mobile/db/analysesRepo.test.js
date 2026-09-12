import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { dbAll } from './index.js';
import { listAnalyses, getAnalysis, createAnalysis, updateAnalysis, deleteAnalysis } from './analysesRepo.js';
import { isEncrypted } from './fieldCrypto.js';

let db;
beforeEach(async () => { db = await createTestMobileDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-AND-AAAAAAAA';

describe('createAnalysis', () => {
  it('writes the row locally and queues a create operation', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'bddk', title: 'Rapor 1', content: 'içerik' });
    expect(row.version).toBe(1);
    expect(row.syncStatus).toBe('pending');

    const queued = await dbAll(db, 'SELECT * FROM sync_queue');
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('create');
    expect(queued[0].entity_id).toBe(row.id);
    expect(queued[0].base_version).toBeNull();

    const [rawRow] = await dbAll(db, 'SELECT title, content FROM analyses WHERE id = ?', [row.id]);
    expect(isEncrypted(rawRow.title)).toBe(true);
    expect(isEncrypted(rawRow.content)).toBe(true);
  });

  it('is immediately visible offline via listAnalyses/getAnalysis', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'btk', title: 'x', content: 'y' });
    expect((await listAnalyses(db, USER)).map((r) => r.id)).toContain(row.id);
    expect((await getAnalysis(db, USER, row.id))?.title).toBe('x');
  });
});

describe('updateAnalysis', () => {
  it('bumps the local version and queues an update with the pre-edit version as baseVersion', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const updated = await updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A2' });

    expect(updated.version).toBe(2);
    expect(updated.title).toBe('A2');

    const queued = await dbAll(db, "SELECT * FROM sync_queue WHERE op = 'update'");
    expect(queued).toHaveLength(1);
    expect(queued[0].base_version).toBe(1);
  });

  it('returns null for a record that does not belong to the user', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    expect(await updateAnalysis(db, { userId: 'BOLD-999', deviceId: DEVICE, id: row.id, title: 'hijack' })).toBeNull();
  });
});

describe('deleteAnalysis', () => {
  it('soft-deletes locally (tombstone) and disappears from listAnalyses', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    expect(await deleteAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id })).toBe(true);

    expect(await listAnalyses(db, USER)).toHaveLength(0);
    expect(await getAnalysis(db, USER, row.id)).toBeNull();

    const [rawRow] = await dbAll(db, 'SELECT * FROM analyses WHERE id = ?', [row.id]);
    expect(rawRow.deleted_at).not.toBeNull();
  });
});
