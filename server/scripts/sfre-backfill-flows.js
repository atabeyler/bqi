// Fills the weekly net-flow gaps that monthly TEFAS files leave at each month start.
//   node scripts/sfre-backfill-flows.js [--lag-days 1] [--dry-run]
// The importer computes net_flow_ratio = (units_t - units_{t-7}) * price_t / aum_{t-7} INSIDE one file, so the first 7 days of every
// monthly export have no flow. Once the neighbouring month is in the database, the missing values can be derived exactly the same way.
// Only fund-days whose net_flow_ratio is absent AND whose t-7 units/aum and t price are observed are added; nothing is guessed.
// Observations carry the same source/flags as the importer's, so re-running is idempotent (hash-deduplicated).
import 'dotenv/config';
import pg from 'pg';
import { PgStore } from '../src/sfre/storage/pgStore.js';
import { mkObs } from '../src/sfre/ingest/parse.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const LAG = Number(arg('lag-days', 1)); const DRY = process.argv.includes('--dry-run'); const DAY = 86400000;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
const rows = (await client.query("SELECT entity, floor(extract(epoch from event_time) / 86400)::int AS day, field, (value #>> '{}')::float8 AS v FROM sfre_observations WHERE source='tefas:tarihsel' AND field IN ('units','nav_price','aum','net_flow_ratio')")).rows;
const funds = new Map();
for (const r of rows) { if (!funds.has(r.entity)) funds.set(r.entity, new Map()); const m = funds.get(r.entity); if (!m.has(r.day)) m.set(r.day, {}); const o = m.get(r.day); if (r.field === 'units') o.u = r.v; else if (r.field === 'nav_price') o.p = r.v; else if (r.field === 'aum') o.a = r.v; else o.f = r.v; }
const obs = []; let had = 0;
for (const [entity, m] of funds) {
  for (const [day, cur] of m) {
    if (cur.f !== undefined) { had++; continue; }
    const prev = m.get(day - 7);
    if (!prev || cur.u === undefined || prev.u === undefined || !(cur.p > 0) || !(prev.a > 0)) continue;
    const eventMs = day * DAY;
    obs.push(mkObs({ entity, field: 'net_flow_ratio', value: ((cur.u - prev.u) * cur.p) / prev.a, unit: 'ratio', eventMs, availableMs: eventMs + LAG * DAY, source: 'tefas:tarihsel', flags: ['VENDOR_DERIVED'] }));
  }
}
console.log(`fund-days with a flow already: ${had}; derivable now: ${obs.length}`);
if (DRY || !obs.length) { await client.end(); process.exit(0); }
const store = new PgStore((t, p) => client.query(t, p));
let inserted = 0; let duplicates = 0;
for (let i = 0; i < obs.length; i += 20000) { const r = await store.addObservations(obs.slice(i, i + 20000)); inserted += r.inserted; duplicates += r.duplicates; }
console.log(`inserted ${inserted}, duplicates ${duplicates}`);
await client.end();
