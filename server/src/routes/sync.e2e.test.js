import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createFakePool } from './syncTestHelpers.js';

// True multi-device end-to-end coverage: the REAL desktop sync engine
// (desktop/sync/engine.js, unmodified) running against a REAL, ephemeral,
// in-process HTTP server wrapping the REAL Express sync routes
// (server/src/routes/sync.js, unmodified) -- real fetch() calls over a
// real socket, real bcrypt-free JWTs signed/verified by the real
// jsonwebtoken lib, real SQLite (better-sqlite3, in-memory) on the
// "device" side. Only Postgres itself is faked (createFakePool, shared
// with sync.test.js) since this sandbox has no live database -- everything
// else in the request path is the genuine, shipped code.
//
// Desktop's sync/queue/conflict/entityHandlers modules have zero external
// npm dependencies of their own (only node:fs/path/crypto plus sibling
// imports). desktop/testHelpers.js does need better-sqlite3, but resolves
// it from the repo ROOT's node_modules (better-sqlite3 is already a real
// root dependency, needed by the desktop app itself) -- NOT from a copy
// added to server/package.json. A better-sqlite3 devDependency was tried
// here once and reverted: `npm install --prefix server` installs
// devDependencies too and tries to compile its native addon against the
// build image's Node ABI, which fails there. The CI "server" job installs
// root dependencies as an extra step instead (see .github/workflows/ci.yml)
// so this import resolves in CI without touching what the production
// Docker build ever installs (server/'s and client/'s own deps only).
const { createTestDb } = await import('../../../desktop/testHelpers.js');

let fakePool;
vi.mock('../services/database.js', () => ({ getPool: () => fakePool }));

const { default: syncRouter } = await import('./sync.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

const { runSync } = await import('../../../desktop/sync/engine.js');
const { getDueOperations, hasPendingOrInFlight } = await import('../../../desktop/sync/queue.js');
const { listUnresolvedConflicts, resolveConflict } = await import('../../../desktop/sync/conflict.js');
const { createAnalysis, updateAnalysis, deleteAnalysis, getAnalysis } = await import('../../../desktop/db/analysesRepo.js');

const USER = 'BOLD-001';
const DEVICE_A = 'BQI-WIN-DEVICEAAA';
const DEVICE_B = 'BQI-AND-DEVICEBBB';

function token(userCode, options = {}) {
  return jwt.sign({ userCode }, JWT_SECRET, { expiresIn: '1h', ...options });
}

function ctx(deviceId, jwtToken, baseUrl) {
  return { apiBaseUrl: baseUrl, getToken: () => jwtToken, deviceId, userId: USER };
}

let server;
let baseUrl;

beforeEach(async () => {
  fakePool = createFakePool();
  fakePool._registerDevice(DEVICE_A, USER);
  fakePool._registerDevice(DEVICE_B, USER);

  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('Multi-device sync E2E (real desktop engine + real Express sync routes)', () => {
  // A) Desktop offline -> create an analysis -> connectivity returns -> syncs to the server.
  it('A: an analysis created while offline reaches the server once reconnected', async () => {
    const db = createTestDb();
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'Offline rapor', content: 'içerik' });
    expect(getDueOperations(db)).toHaveLength(1); // nothing sent yet -- still "offline"

    const result = await runSync(db, ctx(DEVICE_A, token(USER), baseUrl));

    expect(result.ok).toBe(true);
    expect(result.push.pushed).toBe(1);
    expect(getAnalysis(db, USER, row.id).syncStatus).toBe('synced');
    expect(fakePool._state.analyses).toHaveLength(1);
  });

  // B) Device A and device B edit the same analysis -> version conflict ->
  // conflict recorded -> user resolves it -> re-sync completes clean.
  it('B: two devices editing the same analysis produce a resolvable conflict, then sync cleanly', async () => {
    const dbA = createTestDb();
    const dbB = createTestDb();

    const row = createAnalysis(dbA, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'Ortak rapor', content: 'v1' });
    await runSync(dbA, ctx(DEVICE_A, token(USER), baseUrl));
    await runSync(dbB, ctx(DEVICE_B, token(USER), baseUrl)); // B pulls A's record down first
    expect(getAnalysis(dbB, USER, row.id)).toBeTruthy();

    updateAnalysis(dbA, { userId: USER, deviceId: DEVICE_A, id: row.id, title: 'A değişti' });
    updateAnalysis(dbB, { userId: USER, deviceId: DEVICE_B, id: row.id, title: 'B değişti' });

    await runSync(dbA, ctx(DEVICE_A, token(USER), baseUrl)); // A syncs first -- wins
    const resultB = await runSync(dbB, ctx(DEVICE_B, token(USER), baseUrl)); // B's stale baseVersion is rejected
    expect(resultB.push.conflicts).toBe(1);

    const conflicts = listUnresolvedConflicts(dbB);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].serverPayload.title).toBe('A değişti');

    resolveConflict(dbB, { conflictId: conflicts[0].id, deviceId: DEVICE_B, resolution: 'kept_server' });
    expect(getAnalysis(dbB, USER, row.id).title).toBe('A değişti');
    expect(listUnresolvedConflicts(dbB)).toHaveLength(0);

    // The server itself still holds A's write, untouched by B's rejected attempt.
    const serverRow = fakePool._state.analyses.find((r) => r.client_id === row.id);
    expect(serverRow.title).toBe('A değişti');
  });

  // C) Delete an analysis while offline -> reconnect -> the deletion (tombstone) reaches the server.
  it('C: a deletion made while offline reaches the server as a tombstone once reconnected', async () => {
    const db = createTestDb();
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'Silinecek', content: 'x' });
    await runSync(db, ctx(DEVICE_A, token(USER), baseUrl));

    deleteAnalysis(db, { userId: USER, deviceId: DEVICE_A, id: row.id });
    const result = await runSync(db, ctx(DEVICE_A, token(USER), baseUrl));

    expect(result.push.pushed).toBe(1);
    const serverRow = fakePool._state.analyses.find((r) => r.client_id === row.id);
    expect(serverRow.deleted_at).not.toBeNull();
  });

  // D) The app closing mid-sync must not lose the queue -- a fresh runSync()
  // against the same (persisted) SQLite db, as happens on relaunch, resumes
  // exactly where the interrupted attempt left off.
  it('D: queued operations survive an interrupted sync and complete on the next run (simulated relaunch)', async () => {
    const db = createTestDb();
    createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'A', content: 'B' });
    createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'C', content: 'D' });
    // Nothing has been pushed yet -- as if the app were killed right after
    // these local writes, before any sync ran. The queue lives in SQLite on
    // disk (well, in this test: the same in-memory handle standing in for
    // "the file that would have persisted"), not in process memory.
    expect(getDueOperations(db)).toHaveLength(2);

    const result = await runSync(db, ctx(DEVICE_A, token(USER), baseUrl));

    expect(result.push.pushed).toBe(2);
    expect(fakePool._state.analyses).toHaveLength(2);
    expect(getDueOperations(db)).toHaveLength(0);
  });

  // E) The exact same operationId sent twice (e.g. a retried push after a
  // dropped response) must not apply the operation a second time.
  it('E: replaying the same operationId does not duplicate the operation', async () => {
    const db = createTestDb();
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'A', content: 'B' });
    const queuedOp = getDueOperations(db)[0];
    const jwtA = token(USER);

    await runSync(db, ctx(DEVICE_A, jwtA, baseUrl));
    expect(fakePool._state.analyses).toHaveLength(1);

    // Replay the identical operationId directly against the server, as a
    // client retry would after never seeing the first response.
    const res = await fetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtA}` },
      body: JSON.stringify({
        deviceId: DEVICE_A,
        operations: [{ operationId: queuedOp.id, entityType: 'analysis', op: 'create', entityId: row.id, payload: { category: 'x', title: 'A', content: 'B' } }],
      }),
    });
    const body = await res.json();

    expect(body.results[0].replayed).toBe(true);
    expect(fakePool._state.analyses).toHaveLength(1); // still just one row, not two
  });

  // F) Reconnecting with an expired JWT must not lose the offline-queued
  // data -- sync just fails (to be retried once a fresh token is available),
  // the local analysis and its queue entry are untouched.
  it('F: an expired JWT on reconnect fails the sync without losing offline data', async () => {
    const db = createTestDb();
    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE_A, category: 'x', title: 'Offline rapor', content: 'x' });
    const expiredJwt = token(USER, { expiresIn: -3600 });

    const result = await runSync(db, ctx(DEVICE_A, expiredJwt, baseUrl));

    expect(result.ok).toBe(false); // both push and pull are rejected (401) -- sync as a whole fails
    expect(fakePool._state.analyses).toHaveLength(0); // nothing reached the server
    // Nothing was lost locally: the analysis and its queued create are still
    // there -- just backed off (not immediately re-"due"), same as any
    // other transient push failure. hasPendingOrInFlight (not
    // getDueOperations, which respects the backoff delay) is the right
    // check for "is this still queued, not lost".
    expect(getAnalysis(db, USER, row.id)).toBeTruthy();
    expect(hasPendingOrInFlight(db, 'analysis', row.id)).toBe(true);

    // Re-authenticate (a fresh token). The failed attempt above also backed
    // the op off a few seconds into the future (same as any other transient
    // push failure) -- simulate that time having passed (a real relaunch or
    // periodic sync timer would just wait it out) so this retry actually
    // picks it up rather than skipping it as "not due yet".
    db.prepare(`UPDATE sync_queue SET next_attempt_at = ?`).run(new Date(0).toISOString());
    const retry = await runSync(db, ctx(DEVICE_A, token(USER), baseUrl));
    expect(retry.ok).toBe(true);
    expect(retry.push.pushed).toBe(1);
    expect(fakePool._state.analyses).toHaveLength(1);
  });
});
