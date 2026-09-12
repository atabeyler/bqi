import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Serves the already-built client/dist SPA over plain HTTP on loopback
// instead of loading it via file://. This matters because the existing
// Vite build (client/vite.config.js) has no `base` override and emits
// root-relative asset URLs (/assets/...) — those resolve fine against an
// http://127.0.0.1 origin exactly like the deployed web app, but break
// under file:// where there is no root to be relative to. Using a local
// server here means the web build config never has to change to
// accommodate Electron.
export function serveStaticDir(rootDir, { port = 0, host = '127.0.0.1' } = {}) {
  // path.resolve (not path.join) collapses any ".." segments before the
  // comparison below, and path.relative + a ".." prefix check catches both
  // traversal *and* the sibling-directory prefix-bypass that a plain
  // `filePath.startsWith(rootDir)` check misses -- e.g. rootDir
  // "/app/dist" would wrongly accept "/app/dist-secrets" since that string
  // also starts with "/app/dist". Works the same way on every OS (this was
  // never actually Windows-specific).
  const resolvedRoot = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.resolve(resolvedRoot, '.' + path.sep + urlPath);

    const relative = path.relative(resolvedRoot, filePath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end();
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || (stats.isDirectory() && !fs.existsSync(path.join(filePath, 'index.html')))) {
        // SPA fallback: any unmatched route serves index.html, same as the
        // server's own catch-all (server/src/index.js) does for the web.
        filePath = path.join(resolvedRoot, 'index.html');
      } else if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(content);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, url: `http://${host}:${address.port}` });
    });
  });
}
