// Real-data trial of the M21 breadth alarm (system-level) on ingested TEFAS weekly flows.
//   node scripts/sfre-breadth-trial.js [--ref-weeks 30] [--trials 200] [--out docs/sfre/results]
// Reference = first N weeks (calibrates each fund's own normal and the alarm level), evaluation = all later weeks (out of time).
//  1. Which real evaluation weeks does it flag? (candidate episodes; judged against independent aggregate statistics)
//  2. Planted systemic episodes: in calm real weeks, a random share p of funds is given a -10% weekly outflow. How often is the week flagged?
//  3. For comparison, the per-fund view: how often is one of those shocked funds caught by its own fund-level z-score?
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { breadthAlarm } from '../src/sfre/engines/breadth.js';
import { Rng } from '../src/sfre/core/prng.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const REF = Number(arg('ref-weeks', 30)); const TRIALS = Number(arg('trials', 200)); const OUT = arg('out', path.join('..', 'docs', 'sfre', 'results'));
const MIN_AUM = 5e7; const MIN_INV = 100; const SHARES = [0.02, 0.05, 0.1, 0.2]; const SHOCK = -0.1;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
const rows = (await client.query("SELECT entity, to_char(event_time,'YYYY-MM-DD') d, field, (value #>> '{}')::float8 v FROM sfre_observations WHERE source='tefas:tarihsel' AND field IN ('net_flow_ratio','aum','investors')")).rows;
await client.end();
const funds = new Map();
for (const r of rows) { if (!funds.has(r.entity)) funds.set(r.entity, new Map()); const m = funds.get(r.entity); if (!m.has(r.d)) m.set(r.d, {}); const o = m.get(r.d); if (r.field === 'net_flow_ratio') o.f = r.v; else if (r.field === 'aum') o.a = r.v; else o.i = r.v; }
const isFriday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5;
const dates = [...new Set(rows.filter((r) => r.field === 'net_flow_ratio' && isFriday(r.d)).map((r) => r.d))].sort();
const eligible = [];
for (const [code, m] of funds) {
  const last = [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))[0][1]; if (!(last.a >= MIN_AUM) || !(last.i >= MIN_INV)) continue;
  const flows = dates.map((d) => { const o = m.get(d); return o && o.f !== undefined && Math.abs(o.f) <= 1 ? o.f : null; });
  if (flows.filter((x) => x !== null).length < REF) continue;
  eligible.push({ code, flows, aum: last.a });
}
console.log(`${eligible.length} funds, ${dates.length} Fridays ${dates[0]}..${dates[dates.length - 1]}, reference = first ${REF} weeks`);
const M = eligible.map((f) => f.flows); const ref = M.map((r) => r.slice(0, REF)); const ev = M.map((r) => r.slice(REF)); const evDates = dates.slice(REF);
const real = breadthAlarm({ reference: ref, evaluation: ev });
if (real.status === 'INSUFFICIENT_DATA') { console.error(real.notes); process.exit(3); }
const V = real.value;
const agg = evDates.map((_, t) => { let s = 0; let w = 0; for (let i = 0; i < eligible.length; i++) { const x = ev[i][t]; if (x === null) continue; s += x * eligible[i].aum; w += eligible[i].aum; } return w ? s / w : null; });

// planted systemic episodes in calm weeks
const calm = V.weeks.filter((w) => !w.flagged && w.breadth !== null).map((w) => w.index);
const rng = new Rng(2026); const planted = {};
for (const p of SHARES) {
  let caught = 0; let fundCaught = 0; let fundTotal = 0;
  for (let k = 0; k < TRIALS; k++) {
    const t = calm[Math.floor(rng.next() * calm.length)]; const evCopy = ev.map((r) => r.slice());
    const n = Math.max(1, Math.round(p * eligible.length)); const idx = new Set(); while (idx.size < n) idx.add(Math.floor(rng.next() * eligible.length));
    for (const i of idx) evCopy[i][t] = SHOCK;
    const r = breadthAlarm({ reference: ref, evaluation: evCopy });
    if (r.value.flaggedWeeks.includes(t)) caught++;
    // per-fund view: robust z of the shocked fund against its own reference (same 3-sigma convention as the breadth hit rule)
    for (const i of idx) { const rr = ref[i].filter((x) => x !== null); const med = [...rr].sort((a, b) => a - b)[Math.floor(rr.length / 2)]; const mad = Math.max(1.4826 * [...rr.map((x) => Math.abs(x - med))].sort((a, b) => a - b)[Math.floor(rr.length / 2)], 0.005); fundTotal++; if ((SHOCK - med) / mad < -3) fundCaught++; }
  }
  planted[p] = { shockedFunds: Math.round(p * eligible.length), weekCaught: caught / TRIALS, perFundCaught: fundCaught / fundTotal };
}
const report = { generated: new Date().toISOString(), funds: eligible.length, referenceWeeks: REF, evaluationWeeks: evDates.length, baseline: V.baseline, alarmLevel: V.alarmLevel, weeks: V.weeks.map((w, i) => ({ date: evDates[i], breadth: w.breadth, flagged: w.flagged, aumWeightedFlow: agg[i] })), plantedSystemic: planted, calmWeeks: calm.length };
mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, 'breadth-trial-tefas.json'), JSON.stringify(report, null, 2));
const pc = (x) => `${(100 * x).toFixed(1)}%`;
let md = `# M21 yaygınlık (breadth) alarmı — gerçek TEFAS haftalık akışları\n\n${report.generated.slice(0, 10)} · ${eligible.length} fon · referans = ilk ${REF} hafta (her fonun kendi normali + alarm seviyesi), değerlendirme = sonraki ${evDates.length} hafta (zaman dışı).\n\nAlarm = aynı haftada fonların hangi payı **kendi normalinin** 3 MAD altında çıkış yaptı. Referans dönemde bu payın ortalaması %${(100 * V.baseline.meanBreadth).toFixed(1)}, std %${(100 * V.baseline.sdBreadth).toFixed(1)}; alarm seviyesi **%${(100 * V.alarmLevel).toFixed(1)}**.\n\n## Gerçek değerlendirme haftaları\n\n| Hafta sonu | Yaygınlık | Alarm | Fon büyüklüğü ağırlıklı net akış |\n|---|---|---|---|\n${report.weeks.map((w) => `| ${w.date} | ${w.breadth === null ? '—' : pc(w.breadth)} | ${w.flagged ? '**EVET**' : ''} | ${w.aumWeightedFlow === null ? '—' : pc(w.aumWeightedFlow)} |`).join('\n')}\n\n## Eklenen sistem olayları (sakin gerçek haftalarda, rastgele fon payına −%10 çıkış)\n\n| Etkilenen fon payı | Fon sayısı | Haftayı yakalama (breadth) | Tek tek fon yakalama (fon z-skoru) |\n|---|---|---|---|\n${SHARES.map((p) => `| ${pc(p)} | ${planted[p].shockedFunds} | ${pc(planted[p].weekCaught)} | ${pc(planted[p].perFundCaught)} |`).join('\n')}\n\nSakin hafta sayısı: ${calm.length}; deneme sayısı her pay için ${TRIALS}. Gerçek haftalardaki alarmlar nedeni hakkında bir şey söylemez, yalnızca yaygın eşzamanlı çıkışı gösterir.\n`;
writeFileSync(path.join(OUT, 'breadth-trial-tefas.md'), md);
console.log(md);
