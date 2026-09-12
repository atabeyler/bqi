// Tracks whether the database is actually usable (initDatabase() and all
// critical table-ensure steps have resolved), independent of whether the
// HTTP port is open. server/src/index.js opens the port before DB init
// completes (see its own comment), so a readiness probe must be able to
// tell "process is up" apart from "DB is actually ready" (BQI-004).
let ready = false;

export function setDbReady(value) {
  ready = value;
}

export function isDbReady() {
  return ready;
}
