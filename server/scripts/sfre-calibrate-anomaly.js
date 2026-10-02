// Empirical calibration of the M20 SPC thresholds (robust-z, EWMA, CUSUM) on REAL TEFAS weekly flows.
//   node scripts/sfre-calibrate-anomaly.js [--funds 300] [--alpha 0.05] [--out docs/sfre/results]
// The textbook thresholds assume Gaussian i.i.d. data; fund flows are heavy-tailed, so they alarm far too often.
// Method: fund-split cross-validation. Funds are split in two disjoint halves (even/odd rank). Thresholds are set on the TRAIN half
// as the (1-alpha) quantile of each detector's max-score statistic over real, untouched evaluation windows. They are then
// evaluated on the HELD-OUT half: false-alarm rate on untouched windows, and detection of planted redemptions (-10/-20/-30% of AUM).
// An out-of-time split is impossible here (30 weeks of reference are needed, which consumes most of the 13 months).
// This produces candidate thresholds and evidence only. It changes no model and no status.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PARAMS, robustZDetector, ewmaDetector, cusumDetector, changePointDetector } from '../src/sfre/engines/anomaly/detectors.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const NFUNDS = Number(arg('funds', 300)); const ALPHA = Number(arg('alpha', 0.05)); const OUT = arg('out', path.join('..', 'docs', 'sfre', 'results'));
const MIN_AUM = 5e7; const MIN_INV = 100; const MIN_WEEKS = 30; const EVAL = 4; const SHOCKS = [0.1, 0.2, 0.3];
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
const rows = (await client.query("SELECT entity, to_char(event_time,'YYYY-MM-DD') d, field, (value #>> '{}')::float8 v FROM sfre_observations WHERE source='tefas:tarihsel' AND field IN ('net_flow_ratio','aum','investors')")).rows;
await client.end();
const funds = new Map();
for (const r of rows) { if (!funds.has(r.entity)) funds.set(r.entity, new Map()); const m = funds.get(r.entity); if (!m.has(r.d)) m.set(r.d, {}); const o = m.get(r.d); if (r.field === 'net_flow_ratio') o.f = r.v; else if (r.field === 'aum') o.a = r.v; else o.i = r.v; }
const series = [];
for (const [code, m] of funds) {
  const pts = [...m.entries()].filter(([d, o]) => o.f !== undefined && new Date(`${d}T00:00:00Z`).getUTCDay() === 5).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (pts.length < MIN_WEEKS) continue; const last = pts[pts.length - 1][1]; if (!(last.a >= MIN_AUM) || !(last.i >= MIN_INV)) continue;
  const flows = pts.map(([, o]) => o.f); if (flows.some((x) => Math.abs(x) > 1)) continue; series.push({ code, flows });
}
series.sort((a, b) => (a.code < b.code ? -1 : 1)); const step = Math.max(1, Math.floor(series.length / NFUNDS)); const sample = series.filter((_, i) => i % step === 0).slice(0, NFUNDS);
const train = sample.filter((_, i) => i % 2 === 0); const test = sample.filter((_, i) => i % 2 === 1);

const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const q = (a, p) => { const s = Float64Array.from(a).sort(); const i = (s.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
// per-window scores of the three SPC detectors + the (unchanged) change-point verdict
function scores(ref, ev) {
  const z = robustZDetector(ref, ev); const e = ewmaDetector(ref, ev); const c = cusumDetector(ref, ev); const cp = changePointDetector(ref, ev);
  if ([z, e, c].some((d) => d.status === 'INSUFFICIENT_DATA')) return null;
  return { z: z.score, e: e.score, c: c.score, cp: cp.status === 'SIGNAL' ? 1 : cp.status === 'NO_SIGNAL' ? 0 : null };
}
function windows(set, perturb) {
  const out = [];
  for (const s of set) {
    const v = sd(s.flows);
    for (let end = 26 + EVAL; end <= s.flows.length; end += EVAL) {
      const ref = s.flows.slice(Math.max(0, end - EVAL - 52), end - EVAL); let ev = s.flows.slice(end - EVAL, end); if (perturb !== undefined) ev = ev.slice(0, -1).concat(-perturb);
      const sc = scores(ref, ev); if (sc) out.push({ ...sc, vol: v });
    }
  }
  return out;
}
const t0 = Date.now();
const trainCtl = windows(train); const testCtl = windows(test);
const testShock = Object.fromEntries(SHOCKS.map((k) => [k, windows(test, k)]));
// thresholds: (1-alpha) quantile of each detector's score over untouched TRAIN windows
const cal = { z: q(trainCtl.map((w) => w.z), 1 - ALPHA), e: q(trainCtl.map((w) => w.e), 1 - ALPHA), c: q(trainCtl.map((w) => w.c), 1 - ALPHA) };
const def = { z: PARAMS.robustZ.threshold, e: PARAMS.ewma.L * Math.sqrt(PARAMS.ewma.lambda / (2 - PARAMS.ewma.lambda)), c: PARAMS.cusum.h };
// ensemble rule: majority of the four verdicts (z, ewma, cusum, change point) flag
const verdict = (w, th) => { const v = [w.z > th.z, w.e > th.e, w.c > th.c, w.cp === 1]; return { majority: v.filter(Boolean).length >= 2 + (w.cp === null ? 0 : 0), all: v.every(Boolean), any: v.some(Boolean) }; };
const rate = (ws, th, k) => (ws.length ? ws.filter((w) => verdict(w, th)[k]).length / ws.length : null);
const pct = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
const res = { generated: new Date().toISOString(), funds: { train: train.length, test: test.length }, windows: { trainControl: trainCtl.length, testControl: testCtl.length }, alpha: ALPHA, thresholds: { default: def, calibrated: cal }, elapsedSec: Math.round((Date.now() - t0) / 1000), heldOut: {} };
for (const [name, th] of [['default', def], ['calibrated', cal]]) {
  res.heldOut[name] = { falseAlarm: { z: pct(testCtl.filter((w) => w.z > th.z).length / testCtl.length), ewma: pct(testCtl.filter((w) => w.e > th.e).length / testCtl.length), cusum: pct(testCtl.filter((w) => w.c > th.c).length / testCtl.length), majority: pct(rate(testCtl, th, 'majority')), any: pct(rate(testCtl, th, 'any')) }, detection: Object.fromEntries(SHOCKS.map((k) => [k, { majority: pct(rate(testShock[k], th, 'majority')), any: pct(rate(testShock[k], th, 'any')) }])) };
}
// by volatility tercile (held-out), calibrated thresholds, majority rule
const vols = testCtl.map((w) => w.vol).sort((a, b) => a - b); const t1 = vols[Math.floor(vols.length / 3)]; const t2 = vols[Math.floor((2 * vols.length) / 3)];
const bucket = (w) => (w.vol <= t1 ? 'low' : w.vol <= t2 ? 'mid' : 'high');
res.byVolatility = {};
for (const b of ['low', 'mid', 'high']) {
  const sel = (ws) => ws.filter((w) => bucket(w) === b);
  res.byVolatility[b] = { falseAlarm: { default: pct(rate(sel(testCtl), def, 'majority')), calibrated: pct(rate(sel(testCtl), cal, 'majority')) }, detection: Object.fromEntries(SHOCKS.map((k) => [k, { default: pct(rate(sel(testShock[k]), def, 'majority')), calibrated: pct(rate(sel(testShock[k]), cal, 'majority')) }])) };
}
mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, 'anomaly-threshold-calibration.json'), JSON.stringify(res, null, 2));
const r1 = (x) => (typeof x === 'number' ? x.toFixed(2) : x);
let md = `# M20 eşik kalibrasyonu (gerçek TEFAS haftalık akışları)\n\n${res.generated.slice(0, 10)} · ${train.length} eğitim / ${test.length} test fonu (ayrık) · ${trainCtl.length} eğitim, ${testCtl.length} test penceresi · hedef yanlış alarm (her dedektör) = %${ALPHA * 100}.\n\nEşik = eğitim fonlarının dokunulmamış gerçek pencerelerindeki dedektör skorunun (1-α) yüzdeliği. Sonuçlar **hiç görülmemiş test fonlarında** ölçüldü. Zaman bazlı ayrım mümkün değil (30 haftalık referans verinin çoğunu tüketiyor). Modelleri veya durumlarını değiştirmez.\n\n## Eşikler\n\n| Dedektör | Varsayılan (ders kitabı) | Kalibre |\n|---|---|---|\n| robust-z | ${r1(def.z)} | ${r1(cal.z)} |\n| EWMA | ${r1(def.e)} | ${r1(cal.e)} |\n| CUSUM | ${r1(def.c)} | ${r1(cal.c)} |\n\n## Test fonlarında yanlış alarm (dokunulmamış pencereler)\n\n| Kural | Varsayılan | Kalibre |\n|---|---|---|\n| robust-z | ${res.heldOut.default.falseAlarm.z} | ${res.heldOut.calibrated.falseAlarm.z} |\n| EWMA | ${res.heldOut.default.falseAlarm.ewma} | ${res.heldOut.calibrated.falseAlarm.ewma} |\n| CUSUM | ${res.heldOut.default.falseAlarm.cusum} | ${res.heldOut.calibrated.falseAlarm.cusum} |\n| Çoğunluk (≥2/4) | ${res.heldOut.default.falseAlarm.majority} | ${res.heldOut.calibrated.falseAlarm.majority} |\n| Herhangi biri | ${res.heldOut.default.falseAlarm.any} | ${res.heldOut.calibrated.falseAlarm.any} |\n\n## Test fonlarında yakalama (son hafta bilinen büyüklükte çıkışla değiştirilmiş, çoğunluk kuralı)\n\n| Haftalık çıkış | Varsayılan | Kalibre |\n|---|---|---|\n${SHOCKS.map((k) => `| %${k * 100} | ${res.heldOut.default.detection[k].majority} | ${res.heldOut.calibrated.detection[k].majority} |`).join('\n')}\n\n## Oynaklığa göre (test fonları, çoğunluk kuralı)\n\n| Oynaklık | Yanlış alarm (varsayılan → kalibre) | %10 | %20 | %30 |\n|---|---|---|---|---|\n${['low', 'mid', 'high'].map((b) => `| ${b} | ${res.byVolatility[b].falseAlarm.default} → ${res.byVolatility[b].falseAlarm.calibrated} | ${SHOCKS.map((k) => `${res.byVolatility[b].detection[k].default} → ${res.byVolatility[b].detection[k].calibrated}`).join(' | ')} |`).join('\n')}\n`;
writeFileSync(path.join(OUT, 'anomaly-threshold-calibration.md'), md);
console.log(md);
