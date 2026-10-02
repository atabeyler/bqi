// BFI detection trial on REAL ingested TEFAS fund flows (PostgreSQL, DATABASE_URL).
//   node scripts/sfre-detect-trial.js [--funds 150] [--out docs/sfre/results]
// For each fund, weekly net flow (Fridays) is split into rolling windows: reference = all earlier weeks (<= 52),
// evaluation = the next 4 weeks. Two questions are answered with the real M20 anomaly ensemble:
//   1. False alarms: how often does it signal on the real, untouched evaluation window?
//   2. Detection: when the last evaluation week is REPLACED by a planted redemption of known size (-10/-20/-30% of AUM),
//      how often is it caught? Reported per fund-volatility tercile, because a -10% week is normal for a noisy fund.
// Planted shocks test the machinery on real noise; they are not evidence about any real historical event.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { detectAnomalies } from '../src/sfre/engines/anomaly/ensemble.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const NFUNDS = Number(arg('funds', 150)); const OUT = arg('out', path.join('..', 'docs', 'sfre', 'results'));
const MIN_AUM = 5e7; const MIN_INV = 100; const MIN_WEEKS = 30; const EVAL = 4; const SHOCKS = [0.1, 0.2, 0.3];
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
const rows = (await client.query("SELECT entity, to_char(event_time,'YYYY-MM-DD') d, field, (value #>> '{}')::float8 v FROM sfre_observations WHERE source='tefas:tarihsel' AND field IN ('net_flow_ratio','aum','investors')")).rows;
await client.end();
const funds = new Map();
for (const r of rows) { if (!funds.has(r.entity)) funds.set(r.entity, new Map()); const m = funds.get(r.entity); if (!m.has(r.d)) m.set(r.d, {}); const o = m.get(r.d); if (r.field === 'net_flow_ratio') o.f = r.v; else if (r.field === 'aum') o.a = r.v; else o.i = r.v; }

// weekly (Friday) flow series for eligible funds
const series = [];
for (const [code, m] of funds) {
  const pts = [...m.entries()].filter(([d, o]) => o.f !== undefined && new Date(`${d}T00:00:00Z`).getUTCDay() === 5).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (pts.length < MIN_WEEKS) continue;
  const last = pts[pts.length - 1][1]; if (!(last.a >= MIN_AUM) || !(last.i >= MIN_INV)) continue;
  const flows = pts.map(([, o]) => o.f); if (flows.some((x) => Math.abs(x) > 1)) continue; // liquidation/merge artefacts are not retail-flow noise
  series.push({ code, dates: pts.map(([d]) => d), flows });
}
// deterministic sample
series.sort((a, b) => (a.code < b.code ? -1 : 1)); const step = Math.max(1, Math.floor(series.length / NFUNDS)); const sample = series.filter((_, i) => i % step === 0).slice(0, NFUNDS);

const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const caught = (r) => r.status === 'SIGNAL' || (r.value?.consensus ?? 0) >= 0.5;
let noVerdict = 0; let windowsTotal = 0;
const stats = { control: { n: 0, signal: 0, majority: 0, any: 0 }, shocks: Object.fromEntries(SHOCKS.map((s) => [s, { n: 0, signal: 0, majority: 0, any: 0 }])) };
const byVol = { low: {}, mid: {}, high: {} }; for (const k of Object.keys(byVol)) { byVol[k] = { sdAvg: 0, funds: 0, control: { n: 0, majority: 0 }, shocks: Object.fromEntries(SHOCKS.map((s) => [s, { n: 0, majority: 0 }])) }; }
const vols = sample.map((s) => sd(s.flows)).sort((a, b) => a - b); const t1 = vols[Math.floor(vols.length / 3)]; const t2 = vols[Math.floor((2 * vols.length) / 3)];
const bucket = (v) => (v <= t1 ? 'low' : v <= t2 ? 'mid' : 'high');
const flaggedWeeks = new Map(); // date -> number of funds flagged on a real window ending that date
const t0 = Date.now();
for (const s of sample) {
  const b = bucket(sd(s.flows)); byVol[b].funds++; byVol[b].sdAvg += sd(s.flows);
  for (let end = 26 + EVAL; end <= s.flows.length; end += EVAL) {
    const ref = s.flows.slice(Math.max(0, end - EVAL - 52), end - EVAL); const ev = s.flows.slice(end - EVAL, end);
    const run = (evaluation) => detectAnomalies({ reference: ref, evaluation, seed: 1, label: s.code });
    windowsTotal++; const c = run(ev);
    if (c.status === 'INSUFFICIENT_DATA') { noVerdict++; continue; } // the engine declined to answer (too little history): not a miss, not a hit
    stats.control.n++; byVol[b].control.n++;
    if (c.status === 'SIGNAL') stats.control.signal++; if (caught(c)) { stats.control.majority++; byVol[b].control.majority++; flaggedWeeks.set(s.dates[end - 1], (flaggedWeeks.get(s.dates[end - 1]) || 0) + 1); }
    if (c.status === 'SIGNAL' || c.status === 'MODEL_DISAGREEMENT') stats.control.any++;
    for (const k of SHOCKS) {
      const planted = ev.slice(0, -1).concat(-k); const r = run(planted);
      stats.shocks[k].n++; byVol[b].shocks[k].n++;
      if (r.status === 'SIGNAL') stats.shocks[k].signal++; if (caught(r)) { stats.shocks[k].majority++; byVol[b].shocks[k].majority++; }
      if (r.status === 'SIGNAL' || r.status === 'MODEL_DISAGREEMENT') stats.shocks[k].any++;
    }
  }
}
const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(1)}%` : '—');
const top = [...flaggedWeeks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const report = { generated: new Date().toISOString(), funds: sample.length, eligibleFunds: series.length, windows: stats.control.n, windowsTotal, noVerdict, elapsedSec: Math.round((Date.now() - t0) / 1000), volatilityTerciles: { lowMaxSd: t1, midMaxSd: t2 }, falseAlarms: stats.control, detection: stats.shocks, byVolatility: byVol, topFlaggedWeeks: top };
mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, 'detection-trial-tefas.json'), JSON.stringify(report, null, 2));
let md = `# BFI tespit denemesi (gerçek TEFAS akışları, M20 anomali topluluğu)\n\n${report.generated.slice(0, 10)} · ${sample.length} fon (uygun ${series.length}) · ${stats.control.n} değerlendirilen pencere (${noVerdict} / ${windowsTotal} pencerede motor yetersiz veri nedeniyle yanıt vermedi) · en az ${MIN_AUM / 1e6} milyon TL ve ${MIN_INV} yatırımcı.\n\nHer pencerede referans = önceki ≤52 hafta, değerlendirme = sonraki ${EVAL} hafta. "Yakalandı" = tüm modeller sinyal verdi **veya** modellerin çoğunluğu sinyal verdi.\n\n## Yanlış alarm (gerçek, dokunulmamış pencereler)\n\n| Ölçüt | Oran |\n|---|---|\n| Tüm modeller sinyal | ${pct(stats.control.signal, stats.control.n)} |\n| Çoğunluk sinyal | ${pct(stats.control.majority, stats.control.n)} |\n| Sinyal veya model uyuşmazlığı | ${pct(stats.control.any, stats.control.n)} |\n\n## Yakalama (son hafta, bilinen büyüklükte çıkışla değiştirilmiş)\n\n| Haftalık çıkış | Tüm modeller | Çoğunluk | Sinyal veya uyuşmazlık |\n|---|---|---|---|\n${SHOCKS.map((k) => `| %${k * 100} | ${pct(stats.shocks[k].signal, stats.shocks[k].n)} | ${pct(stats.shocks[k].majority, stats.shocks[k].n)} | ${pct(stats.shocks[k].any, stats.shocks[k].n)} |`).join('\n')}\n\n## Fonun kendi oynaklığına göre yakalama (çoğunluk kuralı)\n\n| Oynaklık | Fon | Ort. haftalık std | Yanlış alarm | %10 | %20 | %30 |\n|---|---|---|---|---|---|---|\n${['low', 'mid', 'high'].map((k) => `| ${k} | ${byVol[k].funds} | ${(byVol[k].sdAvg / Math.max(1, byVol[k].funds) * 100).toFixed(1)}% | ${pct(byVol[k].control.majority, byVol[k].control.n)} | ${SHOCKS.map((s) => pct(byVol[k].shocks[s].majority, byVol[k].shocks[s].n)).join(' | ')} |`).join('\n')}\n\n## Gerçek verideki en çok işaretlenen haftalar (olay adayı; doğrulama gerekir)\n\n| Hafta sonu | İşaretlenen fon |\n|---|---|\n${top.map(([d, n]) => `| ${d} | ${n} |`).join('\n')}\n\n_Not: eklenen şoklar makinenin gerçek gürültü üzerindeki duyarlılığını ölçer; geçmiş bir gerçek olayın yakalandığını kanıtlamaz._\n`;
writeFileSync(path.join(OUT, 'detection-trial-tefas.md'), md);
console.log(md);
