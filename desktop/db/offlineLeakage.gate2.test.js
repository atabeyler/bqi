import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, closeDatabase, getEncryptionKey } from './index.js';
import { createAnalysis, updateAnalysis } from './analysesRepo.js';
import { isEncrypted } from './fieldCrypto.js';
import { recordConflict, resolveConflict, listUnresolvedConflicts } from '../sync/conflict.js';
import { getEntityHandler } from '../sync/entityHandlers.js';

// BQI-002 — Gate 2: offline leakage. Field-level encryption on analyses.
// title/content is worthless if the SAME plaintext still lands, unencrypted,
// in sync_queue.payload or conflicts.local_payload/server_payload — an
// attacker with filesystem access to the desktop SQLite file (a stolen
// laptop, a backup) would still read every report in full.

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-leak-'));
  return path.join(dir, 'bqi.db');
}

afterEach(() => closeDatabase());

const USER = 'BOLD-001';
const DEVICE = 'BQI-WIN-AAAAAAAA';
const SECRET_TITLE = 'ÇOK GİZLİ RAPOR BAŞLIĞI';
const SECRET_CONTENT = 'Bu rapor son derece hassas savunma bilgileri içerir.';

describe('sync_queue never carries plaintext title/content at rest', () => {
  it('createAnalysis enqueues the already-encrypted values, not the plaintext locals', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'savunma', title: SECRET_TITLE, content: SECRET_CONTENT });

    const queued = db.prepare('SELECT payload FROM sync_queue').get();
    expect(queued.payload).not.toContain(SECRET_TITLE);
    expect(queued.payload).not.toContain(SECRET_CONTENT);

    const parsed = JSON.parse(queued.payload);
    expect(isEncrypted(parsed.title)).toBe(true);
    expect(isEncrypted(parsed.content)).toBe(true);
  });

  it('updateAnalysis enqueues the already-encrypted values, not the plaintext locals', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'savunma', title: 'ilk', content: 'ilk icerik' });
    db.prepare("UPDATE sync_queue SET status = 'done'").run();
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: SECRET_TITLE, content: SECRET_CONTENT });

    const queued = db.prepare("SELECT payload FROM sync_queue WHERE status = 'pending'").get();
    expect(queued.payload).not.toContain(SECRET_TITLE);
    expect(queued.payload).not.toContain(SECRET_CONTENT);

    const parsed = JSON.parse(queued.payload);
    expect(isEncrypted(parsed.title)).toBe(true);
    expect(isEncrypted(parsed.content)).toBe(true);
  });

  it('the raw database file on disk never contains the plaintext title/content', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'savunma', title: SECRET_TITLE, content: SECRET_CONTENT });
    db.pragma('wal_checkpoint(FULL)');

    const raw = fs.readFileSync(dbPath, 'latin1');
    expect(raw).not.toContain(SECRET_TITLE);
    expect(raw).not.toContain(SECRET_CONTENT);
  });
});

describe('pulled rows are encrypted before ever touching local disk', () => {
  it('applyPulled encrypts a plaintext server payload with this device key', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    getEntityHandler('analysis').applyPulled(db, USER, {
      entityId: 'remote-1', version: 1, deviceId: 'other-device',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deleted: false,
      payload: { category: 'savunma', title: SECRET_TITLE, content: SECRET_CONTENT },
    });

    const raw = db.prepare('SELECT title, content FROM analyses WHERE id = ?').get('remote-1');
    expect(isEncrypted(raw.title)).toBe(true);
    expect(isEncrypted(raw.content)).toBe(true);
    expect(raw.title).not.toContain(SECRET_TITLE);
    expect(raw.content).not.toContain(SECRET_CONTENT);
  });

  it('the push path (sync/engine.js) decrypts sync_queue payload back to plaintext for the server, without ever storing plaintext locally', async () => {
    const { pushQueue } = await import('../sync/engine.js');

    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'savunma', title: SECRET_TITLE, content: SECRET_CONTENT });

    // At rest: still ciphertext.
    const queuedBefore = db.prepare('SELECT payload FROM sync_queue').get();
    expect(queuedBefore.payload).not.toContain(SECRET_TITLE);

    let sentBody = null;
    const fetchImpl = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({ results: [{ operationId: sentBody.operations[0].operationId, status: 'applied', serverVersion: 1 }] }),
      };
    };

    await pushQueue(db, { apiBaseUrl: 'https://api.test', getToken: () => 'jwt', deviceId: DEVICE, fetchImpl });

    // The server needs the real title/content -- decrypted only at this,
    // the actual network boundary.
    expect(sentBody.operations[0].payload.title).toBe(SECRET_TITLE);
    expect(sentBody.operations[0].payload.content).toBe(SECRET_CONTENT);

    // But it never got persisted anywhere in plaintext beforehand.
    fs.readFileSync(dbPath); // sanity: file exists and is readable
  });
});

describe('conflicts table never carries plaintext title/content at rest', () => {
  it('recordConflict encrypts both the local and server payload before persisting', () => {
    const dbPath = tmpDbPath();
    const key = crypto.randomBytes(32).toString('hex');
    const db = openDatabase(dbPath, { encryptionKey: key });

    const row = createAnalysis(db, { userId: USER, deviceId: DEVICE, category: 'savunma', title: 'yerel', content: 'yerel icerik' });
    db.prepare("UPDATE sync_queue SET status = 'done'").run();
    updateAnalysis(db, { userId: USER, deviceId: DEVICE, id: row.id, title: SECRET_TITLE });

    recordConflict(db, {
      entityType: 'analysis', entityId: row.id,
      localPayload: { title: SECRET_TITLE }, localBaseVersion: 1,
      serverPayload: { title: 'SUNUCUDAKI GİZLİ BAŞLIK', content: 'sunucu icerik', category: 'savunma' },
      serverVersion: 2, serverDeleted: false,
    });

    const raw = db.prepare('SELECT local_payload, server_payload FROM conflicts').get();
    expect(raw.local_payload).not.toContain(SECRET_TITLE);
    expect(raw.server_payload).not.toContain('SUNUCUDAKI GİZLİ BAŞLIK');

    // But callers still get plaintext back through the read API.
    const conflicts = listUnresolvedConflicts(db);
    expect(conflicts[0].localPayload.title).toBe(SECRET_TITLE);
    expect(conflicts[0].serverPayload.title).toBe('SUNUCUDAKI GİZLİ BAŞLIK');
  });
});
