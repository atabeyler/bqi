import { describe, it, expect } from 'vitest';
import { createTestMobileDb } from './testHelpers.js';
import { createDiagnostics } from './diagnostics.js';

describe('createDiagnostics', () => {
  it('writes a structured row for each event', async () => {
    const db = await createTestMobileDb();
    const diag = createDiagnostics(db);
    await diag.info('app_start', { version: '2.1.0' });
    await diag.error('sync_failed', { reason: 'network' });

    const rows = await diag.recent();
    expect(rows).toHaveLength(2);
    // recent() orders newest first
    expect(rows[1]).toMatchObject({ level: 'info', event: 'app_start' });
    expect(JSON.parse(rows[1].meta)).toMatchObject({ version: '2.1.0' });
    expect(rows[0]).toMatchObject({ level: 'error', event: 'sync_failed' });
    expect(JSON.parse(rows[0].meta)).toMatchObject({ reason: 'network' });
    expect(rows[0].ts).toBeTruthy();
  });

  it('redacts sensitive keys (jwt, password, authorization, report content) regardless of caller', async () => {
    const db = await createTestMobileDb();
    const diag = createDiagnostics(db);
    await diag.info('leaky_event', {
      jwt: 'header.payload.sig',
      password: 'hunter2',
      Authorization: 'Bearer xyz',
      offlinePasswordHash: '$2a$10$...',
      title: 'Gizli rapor başlığı',
      content: 'Hassas rapor içeriği',
      userId: 'BOLD-001', // not sensitive -- kept
    });

    const [row] = await diag.recent();
    const meta = JSON.parse(row.meta);
    expect(meta.jwt).toBe('[redacted]');
    expect(meta.password).toBe('[redacted]');
    expect(meta.Authorization).toBe('[redacted]');
    expect(meta.offlinePasswordHash).toBe('[redacted]');
    expect(meta.title).toBe('[redacted]');
    expect(meta.content).toBe('[redacted]');
    expect(meta.userId).toBe('BOLD-001');
  });

  it('never throws even if the write itself fails', async () => {
    const db = await createTestMobileDb();
    await db.close();
    const diag = createDiagnostics(db); // db is now closed -- every write must fail internally
    await expect(diag.info('anything', {})).resolves.toBeUndefined();
  });
});
