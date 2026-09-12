import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanFile, isFileScanConfigured } from './fileScan.js';

const ORIGINAL_URL = process.env.FILE_SCAN_WEBHOOK_URL;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.FILE_SCAN_WEBHOOK_URL;
  else process.env.FILE_SCAN_WEBHOOK_URL = ORIGINAL_URL;
  vi.unstubAllGlobals();
});

describe('isFileScanConfigured', () => {
  it('reflects whether FILE_SCAN_WEBHOOK_URL is set', () => {
    delete process.env.FILE_SCAN_WEBHOOK_URL;
    expect(isFileScanConfigured()).toBe(false);
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    expect(isFileScanConfigured()).toBe(true);
  });
});

describe('scanFile', () => {
  it('is a no-op pass when no webhook is configured, for a low-sensitivity upload', async () => {
    delete process.env.FILE_SCAN_WEBHOOK_URL;
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'INTERNAL' });
    expect(result).toEqual({ ok: true, scanned: false, reason: expect.stringContaining('not configured') });
  });

  // Previously this fell through to the same no-op "not configured" allow
  // as INTERNAL/PUBLIC, regardless of classification -- an unconfigured
  // scanner (the common case for any deployment that hasn't set up a
  // webhook yet) let a RESTRICTED upload through completely unscanned.
  it('rejects a CONFIDENTIAL/RESTRICTED upload when no webhook is configured at all', async () => {
    delete process.env.FILE_SCAN_WEBHOOK_URL;
    const restricted = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'RESTRICTED' });
    expect(restricted.ok).toBe(false);
    expect(restricted.reason).toContain('RESTRICTED');
    const confidential = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'CONFIDENTIAL' });
    expect(confidential.ok).toBe(false);
  });

  it('allows a file the webhook reports clean', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ clean: true }) })));
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt' });
    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(true);
  });

  it('rejects a file the webhook flags, regardless of classification', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ clean: false, reason: 'EICAR-Test-Signature' }) })));
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'PUBLIC' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EICAR-Test-Signature');
  });

  it('sends the file hash, name, mimetype and size to the webhook -- never the raw bytes', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ clean: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await scanFile(Buffer.from('hello-world'), { filename: 'report.pdf', mimetype: 'application/pdf' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      filename: 'report.pdf', mimetype: 'application/pdf', size: 11,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('fails open (allows) on a scan-infrastructure failure for a low-sensitivity classification', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'INTERNAL' });
    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(false);
  });

  it('fails closed (rejects) on a scan-infrastructure failure for CONFIDENTIAL/RESTRICTED uploads', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const confidential = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'CONFIDENTIAL' });
    expect(confidential.ok).toBe(false);

    const restricted = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'RESTRICTED' });
    expect(restricted.ok).toBe(false);
  });

  it('treats a non-2xx webhook response as a scan failure (same fail-open/closed rule applies)', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'PUBLIC' });
    expect(result.ok).toBe(true); // fails open for PUBLIC
    expect(result.scanned).toBe(false);
  });

  it('treats a malformed webhook response (missing "clean" boolean) as a scan failure', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'weird' }) })));
    const result = await scanFile(Buffer.from('hello'), { filename: 'a.txt', classification: 'RESTRICTED' });
    expect(result.ok).toBe(false); // fails closed for RESTRICTED
  });
});
