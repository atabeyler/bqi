import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { createAnalysis, updateAnalysis } from '../db/analysesRepo.js';
import { dbGet } from '../db/index.js';
import { getDueOperations, markInFlight, markDone, markFailed, hasPendingOrInFlight } from './queue.js';

let db;
beforeEach(async () => { db = await createTestMobileDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-AND-AAAAAAAA';

describe('getDueOperations', () => {
  it('returns at most one op per entity per call (ops on the same record must apply in order)', async () => {
    const row = await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    await updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A2' });
    await updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A3' });

    const due = await getDueOperations(db);
    expect(due).toHaveLength(1);
    expect(due[0].op).toBe('create'); // the oldest queued op for this entity comes first
  });

  it('respects next_attempt_at (does not return ops still backing off)', async () => {
    await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const queued = await dbGet(db, 'SELECT id FROM sync_queue');
    await markFailed(db, queued.id, 'boom');
    expect(await getDueOperations(db)).toHaveLength(0);
  });
});

describe('markFailed', () => {
  it('requeues with backoff before giving up, and marks failed after MAX_ATTEMPTS', async () => {
    await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const id = (await dbGet(db, 'SELECT id FROM sync_queue')).id;

    for (let i = 0; i < 7; i++) await markFailed(db, id, `attempt ${i}`);
    let row = await dbGet(db, 'SELECT * FROM sync_queue WHERE id = ?', [id]);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(7);

    await markFailed(db, id, 'final');
    row = await dbGet(db, 'SELECT * FROM sync_queue WHERE id = ?', [id]);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('final');
  });
});

describe('markInFlight / markDone', () => {
  it('moves an op through the lifecycle without losing it', async () => {
    await createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const queued = await dbGet(db, 'SELECT * FROM sync_queue');

    await markInFlight(db, queued.id);
    expect(await hasPendingOrInFlight(db, 'analysis', queued.entity_id)).toBe(true);

    await markDone(db, queued.id);
    expect((await dbGet(db, 'SELECT status FROM sync_queue WHERE id = ?', [queued.id])).status).toBe('done');
    expect(await hasPendingOrInFlight(db, 'analysis', queued.entity_id)).toBe(false);
  });
});
