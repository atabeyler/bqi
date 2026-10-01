// SFRE data ingestion CLI (writes validated, hash-checked, PIT-stamped observations to PostgreSQL).
//   node scripts/sfre-ingest.js tefas <file.xlsx|csv> [--lag-days 1]
//   node scripts/sfre-ingest.js bist-eod <file> | free-float <file> [--lag-days 1] | holdings <file> [--lag-days 10]
//   node scripts/sfre-ingest.js kap-sync [--param key=value ...] | kap-probe
// Requires DATABASE_URL (same database as the rest of BQI). KAP needs SFRE_KAP_BASE_URL + SFRE_KAP_API_KEY.
import { readFileSync } from 'node:fs';
import { getPool } from '../src/services/database.js';
import { PgStore } from '../src/sfre/storage/pgStore.js';
import { importTefas } from '../src/sfre/ingest/tefas.js';
import { importBistEod, importFreeFloat } from '../src/sfre/ingest/bist.js';
import { importHoldings } from '../src/sfre/ingest/holdings.js';
import { KapClient, kapConfig } from '../src/sfre/ingest/kap.js';

const [kind, file, ...rest] = process.argv.slice(2);
const opt = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const params = Object.fromEntries(process.argv.filter((a, i) => process.argv[i - 1] === '--param').map((a) => a.split('=')));
void rest;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const store = new PgStore((t, p) => getPool().query(t, p));
await store.ensureSchema();

async function save(result) {
  const r = await store.addObservations(result.observations);
  console.log(JSON.stringify({ kind, ...result.report, skipped: result.skipped, inserted: r.inserted, duplicates: r.duplicates, rejected: r.rejected.length }, null, 2));
}

try {
  const lag = opt('lag-days', undefined); const lagDays = lag === undefined ? undefined : Number(lag);
  if (kind === 'tefas') await save(importTefas(readFileSync(file), { lagDays }));
  else if (kind === 'bist-eod') await save(importBistEod(readFileSync(file)));
  else if (kind === 'free-float') await save(importFreeFloat(readFileSync(file), { lagDays }));
  else if (kind === 'holdings') await save(importHoldings(readFileSync(file), { lagDays }));
  else if (kind === 'kap-probe' || kind === 'kap-sync') {
    const client = new KapClient({ config: kapConfig() });
    if (!client.isConfigured()) { console.error('KAP not configured: set SFRE_KAP_BASE_URL and SFRE_KAP_API_KEY'); process.exit(3); }
    if (kind === 'kap-probe') { const body = await client.call('disclosures', params); console.log(JSON.stringify(Array.isArray(body) ? body.slice(0, 2) : body, null, 2).slice(0, 4000)); }
    else { const r = await client.syncDisclosures(params); await save({ observations: r.observations, skipped: [], report: { total: r.total, accepted: r.disclosures.length, rejected: r.rejected } }); }
  } else { console.error('usage: sfre-ingest.js tefas|bist-eod|free-float|holdings <file> | kap-probe | kap-sync'); process.exit(2); }
} finally { await getPool().end(); }
