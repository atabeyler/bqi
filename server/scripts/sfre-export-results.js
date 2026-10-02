// Push RESULTS from this local BFI node to the cloud app. Raw observations never leave this machine.
//   SFRE_CLOUD_URL=https://bqi.onrender.com SFRE_FEDERATION_SECRET=<same 32+ char secret as the cloud> \
//   node scripts/sfre-export-results.js [--node my-pc] [--dir ../docs/sfre/results] [--runs 20] [--dry-run]
// Sends (1) every JSON report in --dir (calibration, trials) and (2) the latest --runs analysis runs from the local database.
// Documents are content-addressed, so running this repeatedly only uploads what the cloud has not seen yet.
import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { signPackage, MAX_DOC_BYTES, MAX_DOCS, MIN_SECRET_LENGTH, NODE_ID_RE } from '../src/sfre/federation/package.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const URL_BASE = (process.env.SFRE_CLOUD_URL || '').replace(/\/$/, ''); const SECRET = process.env.SFRE_FEDERATION_SECRET || '';
const NODE = arg('node', hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)); const DIR = arg('dir', path.join('..', 'docs', 'sfre', 'results')); const RUNS = Number(arg('runs', 0));
if (!flag('dry-run') && (!URL_BASE || SECRET.length < MIN_SECRET_LENGTH)) { console.error(`SFRE_CLOUD_URL and SFRE_FEDERATION_SECRET (>= ${MIN_SECRET_LENGTH} chars) are required`); process.exit(2); }
if (!NODE_ID_RE.test(NODE)) { console.error('--node must match [A-Za-z0-9._-]{1,64}'); process.exit(2); }

const docs = []; const skipped = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
  const full = path.join(DIR, f); const payload = JSON.parse(readFileSync(full, 'utf8'));
  if (JSON.stringify(payload).length > MAX_DOC_BYTES) { skipped.push(`${f} (larger than ${MAX_DOC_BYTES} bytes)`); continue; }
  const kind = /calibration/.test(f) ? 'calibration' : 'report';
  docs.push({ kind, title: f.replace(/\.json$/, ''), summary: `${payload.generated ? `generated ${String(payload.generated).slice(0, 10)}` : 'report'}; keys: ${Object.keys(payload).slice(0, 6).join(', ')}`.slice(0, 1000), created_at: payload.generated || statSync(full).mtime.toISOString(), payload });
}
if (RUNS > 0 && process.env.DATABASE_URL) {
  const { default: pg } = await import('pg'); const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const runs = (await c.query("SELECT record FROM sfre_records WHERE collection='runs' ORDER BY created_at DESC LIMIT $1", [RUNS])).rows;
  for (const { record } of runs) { const payload = { run: record }; if (JSON.stringify(payload).length <= MAX_DOC_BYTES) docs.push({ kind: 'run', title: `run ${record.run_id || record.id}`, summary: String(record.label || '').slice(0, 200), created_at: record.created_at || new Date().toISOString(), payload }); else skipped.push(`run ${record.run_id} (too large)`); }
  await c.end();
}
console.log(`${docs.length} documents ready for node "${NODE}"${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}`);
if (flag('dry-run')) { for (const d of docs) console.log(` - ${d.kind} · ${d.title} · ${JSON.stringify(d.payload).length} bytes`); process.exit(0); }

let stored = 0; let duplicates = 0; let refused = false;
for (let i = 0; i < docs.length && !refused; i += MAX_DOCS) {
  const body = { docs: docs.slice(i, i + MAX_DOCS) }; const ts = Date.now();
  const res = await fetch(`${URL_BASE}/api/sfre-federation/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bfi-node': NODE, 'x-bfi-timestamp': String(ts), 'x-bfi-signature': signPackage(body, SECRET, ts) }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`cloud refused the package: HTTP ${res.status} ${out.error || ''}`); process.exitCode = 1; refused = true; break; } // exitCode (not process.exit) so the HTTP handle closes cleanly on Windows
  stored += out.stored; duplicates += out.duplicates;
}
if (!refused) console.log(`done: ${stored} new, ${duplicates} already in the cloud`);
