import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStaticDir } from './staticServer.js';

let handle;
afterEach(() => { handle?.server.close(); });

describe('serveStaticDir', () => {
  it('serves a known asset with the right content type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>BQI</html>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');

    handle = await serveStaticDir(dir);
    const res = await fetch(`${handle.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for an unknown SPA route (client-side routing)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqi-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>BQI</html>');

    handle = await serveStaticDir(dir);
    const res = await fetch(`${handle.url}/dashboard/reports`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('BQI');
  });
});
