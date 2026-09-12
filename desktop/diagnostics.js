import fs from 'node:fs';
import path from 'node:path';

// Production-safe diagnostic log for the desktop app: app lifecycle, sync,
// connectivity, and error events, written as newline-delimited JSON under
// <userData>/logs/desktop.log so a user can attach it to a support request
// without needing devtools open. Never throws past its own boundary --
// a diagnostics write failure (e.g. disk full) must never crash the app.
//
// What must NEVER appear in a log line: JWT, password, Authorization
// header, offlinePasswordHash, or report/analysis content (title/content
// fields carry free-text user data). `redact()` strips those by key name
// regardless of which event logs them; callers should still avoid passing
// them in the first place (only pass counts/ids/booleans as metadata).
const REDACTED_KEYS = new Set([
  'jwt', 'password', 'authorization', 'token', 'offlinepasswordhash',
  'title', 'content', 'payload', 'secret',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per file
const MAX_ROTATED_FILES = 3; // desktop.log.1 .. desktop.log.3, oldest dropped

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

export function createDiagnostics(userDataDir) {
  const dir = path.join(userDataDir, 'logs');
  const file = path.join(dir, 'desktop.log');

  function rotateIfNeeded() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return; // no log file yet -- nothing to rotate
    }
    if (stat.size < MAX_FILE_BYTES) return;
    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (!fs.existsSync(src)) continue;
      if (i === MAX_ROTATED_FILES && fs.existsSync(dst)) fs.unlinkSync(dst);
      fs.renameSync(src, dst);
    }
  }

  function write(level, event, meta) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(meta) });
      fs.appendFileSync(file, line + '\n');
    } catch {
      // Diagnostics logging must never be a reason the app crashes.
    }
  }

  return {
    info: (event, meta) => write('info', event, meta),
    warn: (event, meta) => write('warn', event, meta),
    error: (event, meta) => write('error', event, meta),
    filePath: file,
  };
}
