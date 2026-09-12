import { dbRun, dbAll } from './db/index.js';

// Local diagnostic log for the Android app: app lifecycle, sync,
// connectivity, and local-AI error events, kept in the on-device SQLite
// database (see db/migrations/002_diagnostics.sql) so a problem can be
// diagnosed from the device itself -- mirrors desktop/diagnostics.js's
// event shape and redaction, adapted to Capacitor SQLite's async API in
// place of a rotated flat file. Never throws past its own boundary -- a
// diagnostics write failure must never break the caller's actual work.
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

const MAX_ROWS = 5000; // roughly desktop's 2MB-per-file x 3 rotated files, in row-count terms

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

export function createDiagnostics(db) {
  async function write(level, event, meta) {
    try {
      await dbRun(
        db,
        'INSERT INTO diagnostics_log (ts, level, event, meta) VALUES (?, ?, ?, ?)',
        [new Date().toISOString(), level, event, JSON.stringify(redact(meta) ?? {})]
      );
      // Row-count rotation in place of desktop's file-size rotation: trim
      // back down to MAX_ROWS every so often rather than on every write,
      // since COUNT(*) on every log line would be needless overhead.
      if (Math.random() < 0.01) {
        await dbRun(
          db,
          'DELETE FROM diagnostics_log WHERE id NOT IN (SELECT id FROM diagnostics_log ORDER BY id DESC LIMIT ?)',
          [MAX_ROWS]
        );
      }
    } catch {
      // Diagnostics logging must never be a reason anything else fails.
    }
  }

  return {
    info: (event, meta) => write('info', event, meta),
    warn: (event, meta) => write('warn', event, meta),
    error: (event, meta) => write('error', event, meta),
    // For a future "export/share log" UI (matching desktop's filePath,
    // which a user can attach to a support request) -- returns the most
    // recent entries, newest first.
    recent: (limit = 500) => dbAll(db, 'SELECT ts, level, event, meta FROM diagnostics_log ORDER BY id DESC LIMIT ?', [limit]),
  };
}
