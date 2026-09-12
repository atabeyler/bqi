import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { createAnalysis, updateAnalysis, listAnalyses, getAnalysis } from '../db/analysesRepo.js';
import { pushQueue, pullChanges, runSync } from './engine.js';
import { listUnresolvedConflicts } from './conflict.js';

let db;
beforeEach(() => { db = createTestDb(); });

const USER = 'BOLD-001';
const DEVICE = 'BQI-WIN-AAAAAAAA';
const ctx = (fetchImpl) => ({ apiBaseUrl: 'https://api.test', getToken: () => 'test-jwt', deviceId: DEVICE, userId: USER, fetchImpl });

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('pushQueue', () => {
  it('applies a create and marks the local record synced with the server version', async () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ operationId: db.prepare('SELECT id FROM sync_queue').get().id, status: 'applied', entityId: row.id, serverVersion: 1 }],
    }));

    const result = await pushQueue(db, ctx(fetchImpl));
    expect(result.pushed).toBe(1);
    expect(getAnalysis(db, USER, row.id).syncStatus).toBe('synced');
    expect(db.prepare("SELECT status FROM sync_queue").get().status).toBe('done');
  });

  it('requeues with backoff on network failure — nothing is lost', async () => {
    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });

    const result = await pushQueue(db, ctx(fetchImpl));
    expect(result.error).toBe('network down');
    const queued = db.prepare('SELECT * FROM sync_queue').get();
    expect(queued.status).toBe('pending');
    expect(queued.attempts).toBe(1);
    expect(new Date(queued.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('records a conflict instead of overwriting when the server rejects a stale baseVersion', async () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    db.prepare("UPDATE sync_queue SET status = 'done'").run();
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'Yerel' });
    const opId = db.prepare("SELECT id FROM sync_queue WHERE status = 'pending'").get().id;

    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ operationId: opId, status: 'conflict', entityId: row.id, serverVersion: 5, serverPayload: { title: 'Sunucu', content: 'x', category: 'x' } }],
    }));

    const result = await pushQueue(db, ctx(fetchImpl));
    expect(result.conflicts).toBe(1);
    expect(listUnresolvedConflicts(db)).toHaveLength(1);
    expect(getAnalysis(db, USER, row.id).syncStatus).toBe('conflict');
  });

  it('resumes across multiple passes for a chain of edits to the same record', async () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    db.prepare("UPDATE sync_queue SET status = 'done'").run();
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A2' });
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: 'A3' });

    let version = 1;
    const fetchImpl = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const results = body.operations.map((op) => {
        version += 1;
        return { operationId: op.operationId, status: 'applied', entityId: op.entityId, serverVersion: version };
      });
      return jsonResponse({ results });
    });

    const result = await pushQueue(db, ctx(fetchImpl));
    expect(result.pushed).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one op per entity per pass
    expect(getAnalysis(db, USER, row.id).version).toBe(3);
  });
});

describe('pullChanges', () => {
  it('applies incoming records and persists the cursor across pages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        records: [{ entityType: 'analysis', entityId: 'remote-1', version: 1, deviceId: 'web', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deleted: false, syncRevision: 1, payload: { category: 'x', title: 'Uzak rapor', content: 'içerik' } }],
        nextCursor: 1, hasMore: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ records: [], nextCursor: 1, hasMore: false }));

    const result = await pullChanges(db, ctx(fetchImpl));
    expect(result.pulled).toBe(1);
    expect(listAnalyses(db, USER).map((r) => r.id)).toContain('remote-1');
    expect(db.prepare("SELECT value FROM sync_state WHERE key = 'pull_cursor'").get().value).toBe('1');
  });

  it('does not overwrite a record that still has a pending local edit queued', async () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'Yerel', content: 'y' });
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      records: [{ entityType: 'analysis', entityId: row.id, version: 9, deviceId: 'other-device', createdAt: row.createdAt, updatedAt: '2026-01-01T00:00:00Z', deleted: false, syncRevision: 1, payload: { category: 'x', title: 'Başkasının yazdığı', content: 'z' } }],
      nextCursor: 1, hasMore: false,
    }));

    await pullChanges(db, ctx(fetchImpl));
    expect(getAnalysis(db, USER, row.id).title).toBe('Yerel'); // not clobbered
  });

  it('applies a tombstone for a soft-deleted server record', async () => {
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });
    db.prepare("UPDATE sync_queue SET status = 'done'").run();
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      records: [{ entityType: 'analysis', entityId: row.id, version: 2, deviceId: 'other-device', createdAt: row.createdAt, updatedAt: '2026-01-01T00:00:00Z', deleted: true, syncRevision: 1, payload: null }],
      nextCursor: 1, hasMore: false,
    }));

    await pullChanges(db, ctx(fetchImpl));
    expect(listAnalyses(db, USER)).toHaveLength(0);
    expect(db.prepare('SELECT deleted_at FROM analyses WHERE id = ?').get(row.id).deleted_at).not.toBeNull();
  });
});

describe('runSync', () => {
  it('never throws — a total connectivity failure is reported as ok:false, not an exception', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });

    const result = await runSync(db, ctx(fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('offline');
    // The queued create was never lost -- still pending on disk for the next attempt.
    expect(db.prepare('SELECT status FROM sync_queue').get().status).toBe('pending');
  });

  it('reports ok:true with the push error surfaced when only push fails but pull still runs', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url) => {
      calls++;
      if (url.includes('/push')) throw new Error('push unreachable');
      return jsonResponse({ records: [], nextCursor: 0, hasMore: false });
    });
    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'x', title: 'A', content: 'B' });

    const result = await runSync(db, ctx(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.push.error).toBe('push unreachable');
    expect(result.pull.pulled).toBe(0);
    expect(calls).toBe(2);
  });
});
