import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { dbRun } from '../db/index.js';
import { createLocalAIProvider } from './provider.js';
import { _internal } from './registry.js';

describe('createLocalAIProvider', () => {
  it('never throws even if the underlying query blows up (spec J: no model/crash safety)', async () => {
    const db = await createTestMobileDb();
    await db.close(); // force every query against it to fail
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'raporlarımı bul' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('answers a normal query successfully', async () => {
    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'x', 'Rapor', 'içerik')
    `);
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.type).toBe('find');
  });
});

// Mirrors desktop/localAI/provider.test.js's fallback-chain tests -- see
// that file's comment for the full rationale.
describe('createLocalAIProvider local-llm -> offline-extractive fallback', () => {
  const { PROVIDERS } = _internal;
  let originalLocalLLM;

  beforeEach(() => { originalLocalLLM = { ...PROVIDERS[0] }; });
  afterEach(() => { Object.assign(PROVIDERS[0], originalLocalLLM); });

  it('falls through to offline-extractive when local-llm is selected but the per-request check fails', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('local_llm_unavailable'); },
    });

    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'x', 'Rapor', 'içerik')
    `);
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe('offline-extractive');
  });

  it('falls through to offline-extractive when the native plugin itself is missing', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('android_native_llm_plugin_missing'); },
    });

    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'x', 'Rapor', 'içerik')
    `);
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe('offline-extractive');
  });

  it('falls through to offline-extractive when the native model load fails (observed real-device error)', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('local_llm_native_load_failed'); },
    });

    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'x', 'Rapor', 'içerik')
    `);
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe('offline-extractive');
  });

  it('falls through to offline-extractive when the native load fails with an appended detail suffix', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('local_llm_native_load_failed: UnsatisfiedLinkError'); },
    });

    const db = await createTestMobileDb();
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe('offline-extractive');
  });

  it('does NOT fall through for a non-recoverable local-llm error', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('unexpected_crash'); },
    });

    const db = await createTestMobileDb();
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(false);
    expect(result.capability).toBe('local-llm');
  });

  // offline-extractive always refuses mode==='generate' (see registry.js),
  // so falling through to it for a failed generate request can never
  // succeed -- it would only replace a diagnosable native error with the
  // same generic offline_generation_unavailable every time. Mirrors
  // desktop/localAI/provider.test.js's same case.
  it('does not fall through to offline-extractive for a failed generate request', async () => {
    Object.assign(PROVIDERS[0], {
      isAvailable: () => true,
      createQuery: () => async () => { throw new Error('local_llm_native_load_failed: UnsatisfiedLinkError'); },
    });

    const db = await createTestMobileDb();
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ mode: 'generate', category: 'ekonomi', prompt: 'yeni bir konu' });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('local_llm_native_load_failed: UnsatisfiedLinkError');
    expect(result.capability).toBe('local-llm');
  });
});

// Audit finding: offline-extractive used to quietly synthesize an answer
// from unrelated past reports for a "new analysis" request when no real
// local LLM was available, which read like a genuine generated analysis of
// the requested topic. A "generate" request without local-llm must now
// surface as a clear failure instead.
describe('createLocalAIProvider mode: generate without a real local LLM', () => {
  it('reports failure instead of silently synthesizing an answer from past reports', async () => {
    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'ekonomi', 'Eski Rapor', 'ilgisiz eski içerik')
    `);
    // No local-llm mock installed -- PROVIDERS[0].isAvailable() is false in
    // this test environment (no native plugin), so selectProvider() already
    // picks offline-extractive, exactly the case under test.
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ mode: 'generate', category: 'ekonomi', prompt: 'yeni bir konu' });
    expect(result.ok).toBe(false);
    expect(result.type).not.toBe('archive-synthesis');
  });

  it('still answers a normal (non-generate) chat query via offline-extractive', async () => {
    const db = await createTestMobileDb();
    await dbRun(db, `
      INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
      VALUES ('a', 'BOLD-001', 'BQI-AND-TEST', 1, datetime('now'), datetime('now'), 'synced', 'x', 'Rapor', 'içerik')
    `);
    const provider = createLocalAIProvider({ db, userId: 'BOLD-001' });

    const result = await provider.query({ text: 'rapor' });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe('offline-extractive');
  });
});
