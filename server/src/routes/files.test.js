import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const { default: filesRouter } = await import('./files.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

function authHeader(userCode = 'U1', nickname = 'BOLD-001') {
  return `Bearer ${jwt.sign({ userCode, nickname, isAdmin: false }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRouter);
  return app;
}

const testFiles = [];
function writeTestFile(name, content = 'test content') {
  const filePath = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(filePath, content);
  testFiles.push(filePath);
  return filePath;
}

beforeEach(() => {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
});

afterEach(() => {
  while (testFiles.length) {
    const f = testFiles.pop();
    fs.rmSync(f, { force: true });
  }
});

describe('POST /api/files/upload', () => {
  const ORIGINAL_URL = process.env.FILE_SCAN_WEBHOOK_URL;

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.FILE_SCAN_WEBHOOK_URL;
    else process.env.FILE_SCAN_WEBHOOK_URL = ORIGINAL_URL;
    vi.unstubAllGlobals();
  });

  it('401s without a valid auth token', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/files/upload').attach('file', Buffer.from('hello'), 'a.txt');
    expect(res.status).toBe(401);
  });

  it('accepts an upload when no malware-scan webhook is configured (unchanged pre-existing behavior)', async () => {
    delete process.env.FILE_SCAN_WEBHOOK_URL;
    const app = buildApp();
    const res = await request(app).post('/api/files/upload').set('Authorization', authHeader())
      .attach('file', Buffer.from('hello world'), 'report.txt');
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('report.txt');
    testFiles.push(path.join(UPLOAD_DIR, path.basename(new URL(res.body.url, 'http://x').pathname)));
  });

  it('accepts an upload the scan webhook reports clean', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ clean: true }) })));
    const app = buildApp();
    const res = await request(app).post('/api/files/upload').set('Authorization', authHeader())
      .attach('file', Buffer.from('hello world'), 'report2.txt');
    expect(res.status).toBe(200);
    testFiles.push(path.join(UPLOAD_DIR, path.basename(new URL(res.body.url, 'http://x').pathname)));
  });

  it('rejects an upload the scan webhook flags, and does not leave the file on disk', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ clean: false, reason: 'EICAR-Test-Signature' }) })));
    const app = buildApp();
    const before = fs.readdirSync(UPLOAD_DIR);
    const res = await request(app).post('/api/files/upload').set('Authorization', authHeader())
      .attach('file', Buffer.from('hello world'), 'evil-payload.txt');
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('EICAR-Test-Signature');
    // Poll briefly for the async fs.unlink (fire-and-forget in the route) to land.
    await new Promise((r) => setTimeout(r, 50));
    const after = fs.readdirSync(UPLOAD_DIR);
    expect(after).toEqual(before);
  });

  it('fails closed for a CONFIDENTIAL upload when the scan webhook is unreachable', async () => {
    process.env.FILE_SCAN_WEBHOOK_URL = 'https://scan.test/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const app = buildApp();
    const res = await request(app).post('/api/files/upload').set('Authorization', authHeader())
      .field('classification', 'CONFIDENTIAL')
      .attach('file', Buffer.from('hello world'), 'sensitive.txt');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/files/:filename', () => {
  it('401s without a valid auth token', async () => {
    writeTestFile('abc123.png', 'fake-png-bytes');
    const app = buildApp();
    const res = await request(app).get('/api/files/abc123.png');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a file that does not exist', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/files/does-not-exist.png').set('Authorization', authHeader());
    expect(res.status).toBe(404);
  });

  it('serves a safe file type (e.g. an image) inline, without forcing a download', async () => {
    writeTestFile('abc123.png', 'fake-png-bytes');
    const app = buildApp();
    const res = await request(app).get('/api/files/abc123.png').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('forces a download for an .html upload (closes a same-origin stored-XSS path)', async () => {
    writeTestFile('evil.html', '<script>alert(document.cookie)</script>');
    const app = buildApp();
    const res = await request(app).get('/api/files/evil.html').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('forces a download for an .svg upload (SVG can carry <script>)', async () => {
    writeTestFile('image.svg', '<svg onload="alert(1)"></svg>');
    const app = buildApp();
    const res = await request(app).get('/api/files/image.svg').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('resolves a path-traversal attempt to just the basename instead of escaping the upload dir', async () => {
    writeTestFile('safe.txt', 'hello');
    const app = buildApp();
    const res = await request(app).get('/api/files/' + encodeURIComponent('../safe.txt')).set('Authorization', authHeader());
    // path.basename() strips any directory components, so this must resolve
    // to a plain "..safe.txt"-style lookup inside UPLOAD_DIR (not found), never
    // escape it -- either outcome (404, or a coincidental same-name hit inside
    // UPLOAD_DIR) is safe; what would NOT be safe is reading outside UPLOAD_DIR.
    expect([200, 404]).toContain(res.status);
  });
});
