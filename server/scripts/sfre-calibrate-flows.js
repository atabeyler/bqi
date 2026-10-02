// BFI flow calibration on ingested TEFAS history (PostgreSQL, DATABASE_URL).
//   node scripts/sfre-calibrate-flows.js [--names <dir with tefas_*.xlsx>] [--split 2026-04-01] [--out docs/sfre/results]
// Measures, per fund group: weekly net-flow quantiles (stress redemption fractions), outflow frequencies, flow-vs-return
// asymmetry, and an out-of-sample check (quantiles fitted before --split, exceedance rate measured after it).
// It describes the HISTORICAL distribution of fund flows; it does not forecast and does not promote any model.
import 'dotenv/config';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import pg from 'pg';
import XLSX from 'xlsx';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const NAMES_DIR = arg('names', path.join(homedir(), 'sfre-data', 'raw'));
const SPLIT = arg('split', '2026-04-01');
const OUT = arg('out', path.join('..', 'docs', 'sfre', 'results'));
const MIN_AUM = Number(arg('min-aum', 1e7)); // funds below 10M TRY are noise for systemic purposes
const DAY = 86400000;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

function groupOf(name) {
  const n = (name || '').toLocaleUpperCase('tr-TR');
  if (/PARA PİYASASI|PARA PIYASASI|LİKİT|LIKIT/.test(n)) return 'para_piyasasi';
  if (/HİSSE|HISSE/.test(n)) return 'hisse';
  if (/BORÇLANMA|BORCLANMA|TAHVİL|TAHVIL|BONO/.test(n)) return 'borclanma';
  if (/ALTIN|KIYMETLİ|KIYMETLI|GÜMÜŞ|GUMUS/.test(n)) return 'altin_kiymetli';
  if (/SERBEST/.test(n)) return 'serbest';
  if (/DEĞİŞKEN|DEGISKEN|KARMA|FON SEPETİ|FON SEPETI/.test(n)) return 'degisken_karma';
  return 'diger';
}
const q = (a, p) => { if (!a.length) return null; const i = (a.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const sorted = (a) => Float64Array.from(a).sort();
const clip = (x, lim) => Math.max(-lim, Math.min(lim, x));
function ols(xs, ys) { const n = xs.length; if (n < 30) return null; let sx = 0; let sy = 0; for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; } const mx = sx / n; const my = sy / n; let sxx = 0; let sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); } const b = sxy / sxx; let sse = 0; for (let i = 0; i < n; i++) sse += (ys[i] - my - b * (xs[i] - mx)) ** 2; const se = Math.sqrt(sse / (n - 2) / sxx); return { n, slope: b, se, t: b / se }; }

// names (code -> latest name) from the raw TEFAS exports
const names = new Map();
if (existsSync(NAMES_DIR)) for (const f of readdirSync(NAMES_DIR).filter((x) => /^tefas_.*\.xlsx$/.test(x)).sort()) {
  const rows = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(NAMES_DIR, f)), { type: 'buffer' }).Sheets['Tablo Verisi'], { header: 1 });
  const h = rows.findIndex((r) => r[0] === 'Fon Kodu'); for (const r of rows.slice(h + 1)) if (r[0]) names.set(String(r[0]).toUpperCase(), r[1]);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
const res = await client.query("SELECT entity, to_char(event_time, 'YYYY-MM-DD') AS d, field, (value #>> '{}')::float8 AS v FROM sfre_observations WHERE source = 'tefas:tarihsel' AND field IN ('net_flow_ratio','nav_price','aum')");
await client.end();
const funds = new Map(); // code -> Map(dateStr -> {nav,aum,flow})
for (const r of res.rows) { const code = r.entity.replace('FUND:', ''); if (!funds.has(code)) funds.set(code, new Map()); const m = funds.get(code); if (!m.has(r.d)) m.set(r.d, {}); const o = m.get(r.d); if (r.field === 'nav_price') o.nav = r.v; else if (r.field === 'aum') o.aum = r.v; else o.flow = r.v; }
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- data quality ----
const dq = { fundWeeks: 0, flowAbsGt1: 0, flowAbsGt5: 0, navNonPositive: 0, navDayJumpGt50: 0, aumNonPositive: 0, fundsNoName: 0 };
const obs = []; // {code, group, d, flow, aumPrev, ret(prev week), nextFlow}
for (const [code, m] of funds) {
  if (!names.has(code)) dq.fundsNoName++;
  const g = groupOf(names.get(code));
  for (const [d, o] of m) {
    if (o.nav !== undefined && !(o.nav > 0)) dq.navNonPositive++;
    if (o.aum !== undefined && !(o.aum > 0)) dq.aumNonPositive++;
    const t = Date.parse(`${d}T00:00:00Z`); const prevDay = m.get(dstr(t - DAY)); if (prevDay?.nav > 0 && o.nav > 0 && Math.abs(o.nav / prevDay.nav - 1) > 0.5) dq.navDayJumpGt50++;
    if (o.flow === undefined) continue;
    dq.fundWeeks++; if (Math.abs(o.flow) > 1) dq.flowAbsGt1++; if (Math.abs(o.flow) > 5) dq.flowAbsGt5++;
    const prev = m.get(dstr(t - 7 * DAY)); if (!prev || !(prev.aum >= MIN_AUM)) continue;
    const prev2 = m.get(dstr(t - 14 * DAY)); const ret = prev?.nav > 0 && prev2?.nav > 0 ? prev.nav / prev2.nav - 1 : null; // return over the week BEFORE the flow week
    obs.push({ code, group: g, d, flow: o.flow, ret, aumPrev: prev.aum });
  }
}

// ---- per group stats ----
const stat = (rows) => {
  const f = sorted(rows.map((r) => r.flow)); const n = f.length; if (n < 50) return { n };
  const out = rows.filter((r) => r.flow < 0);
  const wsum = rows.reduce((s, r) => s + r.aumPrev, 0); const wmean = rows.reduce((s, r) => s + r.flow * r.aumPrev, 0) / wsum;
  const pairs = rows.filter((r) => r.ret !== null);
  const neg = pairs.filter((r) => r.ret < 0); const pos = pairs.filter((r) => r.ret >= 0);
  return {
    n, funds: new Set(rows.map((r) => r.code)).size, quantiles: { p01: q(f, 0.001), p1: q(f, 0.01), p5: q(f, 0.05), p25: q(f, 0.25), p50: q(f, 0.5), p75: q(f, 0.75), p95: q(f, 0.95), p99: q(f, 0.99) },
    aumWeightedMeanFlow: wmean, outflowFreq: { gt5pct: out.filter((r) => r.flow < -0.05).length / n, gt10pct: out.filter((r) => r.flow < -0.1).length / n, gt20pct: out.filter((r) => r.flow < -0.2).length / n },
    flowVsReturn: { whenReturnNegative: ols(neg.map((r) => clip(r.ret, 0.2)), neg.map((r) => clip(r.flow, 0.5))), whenReturnPositive: ols(pos.map((r) => clip(r.ret, 0.2)), pos.map((r) => clip(r.flow, 0.5))) },
  };
};
const groups = [...new Set(obs.map((o) => o.group))].sort();
const report = { generated: new Date().toISOString(), source: 'tefas:tarihsel (PostgreSQL)', minAumTRY: MIN_AUM, split: SPLIT, dataQuality: dq, all: stat(obs), groups: {}, outOfSample: {} };
for (const g of groups) report.groups[g] = stat(obs.filter((o) => o.group === g));

// ---- out-of-sample: fit p1/p5/p95/p99 before SPLIT, measure exceedance after ----
for (const g of ['all', ...groups]) {
  const rows = g === 'all' ? obs : obs.filter((o) => o.group === g);
  const train = rows.filter((o) => o.d < SPLIT); const test = rows.filter((o) => o.d >= SPLIT); if (train.length < 200 || test.length < 200) continue;
  const f = sorted(train.map((r) => r.flow)); const lim = { p1: q(f, 0.01), p5: q(f, 0.05), p95: q(f, 0.95), p99: q(f, 0.99) };
  const rate = (fn) => test.filter(fn).length / test.length;
  report.outOfSample[g] = { trainN: train.length, testN: test.length, fitted: lim, exceedance: { belowP1: { expected: 0.01, observed: rate((r) => r.flow < lim.p1) }, belowP5: { expected: 0.05, observed: rate((r) => r.flow < lim.p5) }, aboveP95: { expected: 0.05, observed: rate((r) => r.flow > lim.p95) }, aboveP99: { expected: 0.01, observed: rate((r) => r.flow > lim.p99) } } };
}

// ---- recommended scenario defaults (weekly redemption fraction), documented as historical quantiles ----
report.recommendedRedemptionFractions = Object.fromEntries(Object.entries(report.groups).filter(([, s]) => s.quantiles).map(([g, s]) => [g, { mild_p5: Math.max(0, -s.quantiles.p5), severe_p1: Math.max(0, -s.quantiles.p1), extreme_p01: Math.max(0, -s.quantiles.p01) }]));

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'calibration-tefas-flows.json'), JSON.stringify(report, null, 2));
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);
let md = `# BFI akış kalibrasyonu (TEFAS tarihsel, ${report.generated.slice(0, 10)})\n\nKaynak: \`tefas:tarihsel\` (PostgreSQL). En az ${MIN_AUM.toLocaleString('tr-TR')} TL fon büyüklüğü. Tarihsel dağılımı ölçer; tahmin değildir.\n\n## Veri kalitesi\n\n| Kontrol | Sayı |\n|---|---|\n${Object.entries(dq).map(([k, v]) => `| ${k} | ${v.toLocaleString('tr-TR')} |`).join('\n')}\n\n## Haftalık net akış (fon büyüklüğüne oran)\n\n| Grup | Fon | Fon-hafta | p0.1 | p1 | p5 | medyan | p95 | p99 | >%10 çıkış sıklığı |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const [g, s] of [['TÜMÜ', report.all], ...Object.entries(report.groups)]) if (s.quantiles) md += `| ${g} | ${s.funds ?? ''} | ${s.n} | ${pct(s.quantiles.p01)} | ${pct(s.quantiles.p1)} | ${pct(s.quantiles.p5)} | ${pct(s.quantiles.p50)} | ${pct(s.quantiles.p95)} | ${pct(s.quantiles.p99)} | ${pct(s.outflowFreq.gt10pct)} |\n`;
md += `\n## Getiri → akış duyarlılığı (önceki hafta getirisi, eğim ± std. hata)\n\n| Grup | Getiri < 0 eğimi | t | Getiri ≥ 0 eğimi | t |\n|---|---|---|---|---|\n`;
for (const [g, s] of Object.entries(report.groups)) if (s.flowVsReturn) { const a = s.flowVsReturn.whenReturnNegative; const b = s.flowVsReturn.whenReturnPositive; md += `| ${g} | ${a ? a.slope.toFixed(3) : '—'} | ${a ? a.t.toFixed(1) : '—'} | ${b ? b.slope.toFixed(3) : '—'} | ${b ? b.t.toFixed(1) : '—'} |\n`; }
md += `\n## Örneklem dışı doğrulama (eğitim < ${SPLIT} ≤ test)\n\nBeklenen aşım ile gözlenen aşım yakınsa dağılım kararlıdır.\n\n| Grup | Eğitim | Test | p1 altı (bekl. 1%) | p5 altı (bekl. 5%) | p95 üstü (bekl. 5%) | p99 üstü (bekl. 1%) |\n|---|---|---|---|---|---|---|\n`;
for (const [g, o] of Object.entries(report.outOfSample)) md += `| ${g} | ${o.trainN} | ${o.testN} | ${pct(o.exceedance.belowP1.observed)} | ${pct(o.exceedance.belowP5.observed)} | ${pct(o.exceedance.aboveP95.observed)} | ${pct(o.exceedance.aboveP99.observed)} |\n`;
md += `\n## Önerilen haftalık çıkış oranları (senaryo varsayılanları)\n\n| Grup | Hafif (p5) | Şiddetli (p1) | Aşırı (p0.1) |\n|---|---|---|---|\n${Object.entries(report.recommendedRedemptionFractions).map(([g, r]) => `| ${g} | ${pct(r.mild_p5)} | ${pct(r.severe_p1)} | ${pct(r.extreme_p01)} |`).join('\n')}\n`;
writeFileSync(path.join(OUT, 'calibration-tefas-flows.md'), md);
console.log(md);
