import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnostics } from './diagnostics.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-diag-'));
}

function readLines(dir) {
  const file = path.join(dir, 'logs', 'desktop.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('createDiagnostics', () => {
  it('writes a structured line for each event', () => {
    const dir = tmpDir();
    const diag = createDiagnostics(dir);
    diag.info('app_start', { version: '2.1.0' });
    diag.error('sync_failed', { reason: 'network' });

    const lines = readLines(dir);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'app_start', version: '2.1.0' });
    expect(lines[1]).toMatchObject({ level: 'error', event: 'sync_failed', reason: 'network' });
    expect(lines[0].ts).toBeTruthy();
  });

  it('redacts sensitive keys (jwt, password, authorization, report content) regardless of caller', () => {
    const dir = tmpDir();
    const diag = createDiagnostics(dir);
    diag.info('leaky_event', {
      jwt: 'header.payload.sig',
      password: 'hunter2',
      Authorization: 'Bearer xyz',
      offlinePasswordHash: '$2a$10$...',
      title: 'Gizli rapor başlığı',
      content: 'Hassas rapor içeriği',
      userId: 'BOLD-001', // not sensitive -- kept
    });

    const [line] = readLines(dir);
    expect(line.jwt).toBe('[redacted]');
    expect(line.password).toBe('[redacted]');
    expect(line.Authorization).toBe('[redacted]');
    expect(line.offlinePasswordHash).toBe('[redacted]');
    expect(line.title).toBe('[redacted]');
    expect(line.content).toBe('[redacted]');
    expect(line.userId).toBe('BOLD-001');
  });

  it('never throws even if the log directory cannot be created', () => {
    // A file path where a directory is expected -- mkdirSync must fail.
    const blocker = path.join(tmpDir(), 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const diag = createDiagnostics(path.join(blocker, 'nested'));
    expect(() => diag.info('anything', {})).not.toThrow();
  });

  it('rotates the log file once it exceeds the size cap', () => {
    const dir = tmpDir();
    const diag = createDiagnostics(dir);
    const file = path.join(dir, 'logs', 'desktop.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(3 * 1024 * 1024)); // over the 2MB cap

    diag.info('after_rotation', {});

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    const current = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(current).toHaveLength(1);
    expect(current[0].event).toBe('after_rotation');
  });
});
