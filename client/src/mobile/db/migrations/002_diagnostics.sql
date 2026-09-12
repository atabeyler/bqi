-- Local diagnostic log for the Android app -- app lifecycle, sync,
-- connectivity, and local-AI error events, so a problem can be diagnosed
-- from the device itself. See client/src/mobile/diagnostics.js.
--
-- Deliberately NOT part of 001_init.sql's shared-with-desktop schema:
-- desktop's equivalent (desktop/diagnostics.js) writes newline-delimited
-- JSON to a rotated flat file instead of a DB table, since Electron's main
-- process has plain filesystem access; Android's Capacitor SQLite
-- connection is the simplest durable store available here without adding
-- a Filesystem plugin dependency. Android-only, so it lives in its own
-- migration rather than touching the file both platforms are meant to
-- keep identical.
CREATE TABLE IF NOT EXISTS diagnostics_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,   -- info | warn | error
  event TEXT NOT NULL,
  meta TEXT              -- JSON, redacted (see diagnostics.js's REDACTED_KEYS)
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_log_ts ON diagnostics_log(ts);
