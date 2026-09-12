import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { createAnalysis, updateAnalysis } from '../db/analysesRepo.js';
import { getDueOperations, markInFlight, markDone, markFailed, hasPendingOrInFlight } from './queue.js';

let db;
beforeEach(() => { db = createTestDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-WIN-AAAAAAAA';

describe('getDueOperations', () => {
  it('returns at most one op per entity per call (ops on the same record must apply in order)', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A2' });
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A3' });

    const due = getDueOperations(db);
    expect(due).toHaveLength(1);
    expect(due[0].op).toBe('create'); // the oldest queued op for this entity comes first
  });

  it('respects next_attempt_at (does not return ops still backing off)', () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const queued = db.prepare('SELECT id FROM sync_queue').get();
    markFailed(db, queued.id, 'boom'); // pushes next_attempt_at into the future
    expect(getDueOperations(db)).toHaveLength(0);
    void row;
  });
});

describe('markFailed', () => {
  it('requeues with backoff before giving up, and marks failed after MAX_ATTEMPTS', () => {
    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const id = db.prepare('SELECT id FROM sync_queue').get().id;

    for (let i = 0; i < 7; i++) markFailed(db, id, `attempt ${i}`);
    let row = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id);
    expect(row.status).toBe('pending'); // still retrying
    expect(row.attempts).toBe(7);

    markFailed(db, id, 'final');
    row = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id);
    expect(row.status).toBe('failed'); // given up after MAX_ATTEMPTS, but still on disk
    expect(row.last_error).toBe('final');
  });
});

describe('markInFlight / markDone', () => {
  it('moves an op through the lifecycle without losing it', () => {
    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const id = db.prepare('SELECT id FROM sync_queue').get().id;
    const entityId = db.prepare('SELECT entity_id FROM sync_queue').get().entity_id;

    markInFlight(db, id);
    expect(hasPendingOrInFlight(db, 'analysis', entityId)).toBe(true);

    markDone(db, id);
    expect(db.prepare('SELECT status FROM sync_queue WHERE id = ?').get(id).status).toBe('done');
    expect(hasPendingOrInFlight(db, 'analysis', entityId)).toBe(false);
  });
});
