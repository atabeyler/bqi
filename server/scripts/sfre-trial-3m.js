// BFI experiment on the 3-month test set (Jul-Sep 2026) that is loaded in the live app.
//   node scripts/sfre-trial-3m.js [--from 2026-07-01] [--to 2026-09-30] [--out <dir>]
// Builds the DAILY cross-sectional fund-flow series (AUM-weighted net flow, share of funds with outflow > 5%) from the
// ingested TEFAS observations, runs the real M20 anomaly ensemble on rolling 5-day blocks (reference = everything before the
// block), and writes the exact /api/sfre/runs request for the last block so the same experiment can be replayed in the app.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import pg from 'pg';
import { detectAnomalies } from '../src/sfre/engines/anomaly/ensemble.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = arg('from', '2026-07-01'); const TO = arg('to', '2026-09-30'); const OUT = arg('out', path.join(homedir(), 'sfre-data'));
const BLOCK = 5; const MIN_REF = 30;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
const rows = (await c.query(`
WITH f AS (SELECT entity, (event_time AT TIME ZONE 'UTC')::date d, (value #>> '{}')::float8 flow FROM sfre_observations WHERE source='tefas:tarihsel' AND field='net_flow_ratio' AND event_time >= $1 AND event_time < ($2::date + 1)),
a AS (SELECT entity, (event_time AT TIME ZONE 'UTC')::date d, (value #>> '{}')::float8 aum FROM sfre_observations WHERE source='tefas:tarihsel' AND field='aum'),
i AS (SELECT entity, (event_time AT TIME ZONE 'UTC')::date d, (value #>> '{}')::float8 inv FROM sfre_observations WHERE source='tefas:tarihsel' AND field='investors')
SELECT f.d, count(*)::int n, sum(f.flow * a.aum) / sum(a.aum) AS wflow, avg((f.flow < -0.05)::int) AS out5, percentile_cont(0.5) WITHIN GROUP (ORDER BY f.flow) AS med
FROM f JOIN a ON a.entity = f.entity AND a.d = f.d - 7 JOIN i ON i.entity = f.entity AND i.d = f.d - 7
WHERE a.aum >= 5e7 AND i.inv >= 100 AND abs(f.flow) <= 1 GROUP BY f.d ORDER BY f.d`, [FROM, TO])).rows;
await c.end();
const days = rows.map((r) => ({ d: r.d.toISOString().slice(0, 10), n: r.n, w: r.wflow, o: r.out5, m: r.med }));
console.log(`${days.length} trading days with data ${days[0]?.d} .. ${days[days.length - 1]?.d}; funds/day ~${Math.round(days.reduce((s, x) => s + x.n, 0) / Math.max(1, days.length))}`);
if (days.length < MIN_REF + BLOCK) { console.error('not enough days for the experiment'); process.exit(3); }

const series = { w: days.map((x) => x.w), o: days.map((x) => x.o) };
const results = [];
for (let end = MIN_REF + BLOCK; end <= days.length; end += BLOCK) {
  const row = { block: `${days[end - BLOCK].d}..${days[end - 1].d}`, refDays: end - BLOCK };
  for (const [k, label] of [['w', 'AUM-weighted net flow'], ['o', 'share of funds with outflow >5%']]) {
    const r = detectAnomalies({ reference: series[k].slice(0, end - BLOCK), evaluation: series[k].slice(end - BLOCK, end), seed: 1, label });
    row[k] = { status: r.status, signaling: r.value?.signalingModels?.length ?? 0, available: (r.value?.models || []).filter((m) => m.status !== 'INSUFFICIENT_DATA').length };
  }
  results.push(row);
}
console.log('\nblock                       ref  weighted-flow                 outflow-share');
for (const r of results) console.log(`${r.block}  ${String(r.refDays).padStart(3)}  ${(`${r.w.status} (${r.w.signaling}/${r.w.available})`).padEnd(28)}  ${r.o.status} (${r.o.signaling}/${r.o.available})`);

// the exact request for the final block, ready to replay in the app (Advanced JSON tab or POST /api/sfre/runs)
const last = days.length; const request = { seed: 1, engines: ['anomaly'], label: `3m-trial ${days[last - BLOCK].d}..${days[last - 1].d}`, anomaly: { reference: series.w.slice(0, last - BLOCK), evaluation: series.w.slice(last - BLOCK), label: 'AUM-weighted weekly net flow (daily, TEFAS Jul-Sep 2026)' } };
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'trial3m-request.json'), JSON.stringify(request));
writeFileSync(path.join(OUT, 'trial3m-series.json'), JSON.stringify({ days, results }, null, 2));
console.log(`\nwrote ${path.join(OUT, 'trial3m-request.json')}`);
