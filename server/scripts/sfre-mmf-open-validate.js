/**
 * Open-data validation of the same shock engine on weekly US money-market-fund total assets (FRED: WIMFNS institutional, WRMFNS retail).
 * This is a SYSTEM-LEVEL aggregate, not a fund cross-section, so it tests flow-shock recognition only; it does NOT test the breadth engine (M21).
 * Pre-registered before running: window 104 weeks, warmup 52, z>=5, move>=1% in a week, tolerance +-7 days. Published whatever the result.
 * Usage: node scripts/sfre-mmf-open-validate.js [--out docs/sfre/results/mmf-flow-open-data]
 */
import { writeFileSync } from 'node:fs';
import { detectFxShocks, scoreEvents } from '../src/sfre/engines/fxShock.js';

const PARAMS = { window: 104, warmup: 52, z: 5, minMove: 0.01 };
const EVENTS = [
  { id: 'M1', t0: '2008-09-16', name: 'Reserve Primary Fund "broke the buck" (Lehman sonrası)' },
  { id: 'M2', t0: '2020-03-18', name: 'Mart 2020 prime fon kaçışı (Fed MMLF açıldı)' },
  { id: 'M3', t0: '2023-03-13', name: 'SVB çöküşü sonrası para piyasası fonlarına akın' },
];
const SERIES = [['WIMFNS', 'kurumsal', ['M1', 'M2']], ['WRMFNS', 'bireysel', ['M1', 'M2', 'M3']]];

async function fred(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`); if (!res.ok) throw new Error(`${id} HTTP ${res.status}`);
  const pts = []; for (const line of (await res.text()).split('\n').slice(1)) { const [date, v] = line.trim().split(','); const value = Number(v); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && v && v !== '.' && Number.isFinite(value) && value > 0) pts.push({ date, value }); }
  return pts;
}

async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null; const rows = []; const lines = [];
  for (const [id, label, ids] of SERIES) {
    const pts = await fred(id); const det = detectFxShocks(pts, PARAMS); const ev = EVENTS.filter((e) => ids.includes(e.id) && e.t0 <= pts.at(-1).date && e.t0 >= pts[0].date);
    const sc = scoreEvents(det.flags, ev, 7); const years = (Date.parse(pts.at(-1).date) - Date.parse(pts[0].date)) / (365.25 * 86400000);
    // before 2000 the early FRED values are step-interpolated, so flags there are an artefact; count only from 1990
    const modern = sc.unmatchedFlags.filter((f) => f.date >= '1990-01-01');
    for (const e of sc.events) { rows.push({ ...e, series: id }); lines.push(`| ${e.id} | ${e.name} | ${id} (${label}) | ${e.t0} | ${e.detected ? 'evet' : '**hayır**'} | ${e.flagDate ?? '–'} | ${e.move == null ? '–' : `${(e.move * 100).toFixed(1)}%`} |`); }
    lines.push(`| – | olay dışı işaret (1990+) | ${id} | ${pts[0].date} → ${pts.at(-1).date} | ${modern.length} | ${(modern.length / (years - 10)).toFixed(2)}/yıl | ${modern.map((f) => f.date).join(', ') || '–'} |`);
  }
  const hit = rows.filter((r) => r.detected).length;
  const md = ['# Para piyasası fonu akışı: açık veri doğrulaması (FRED, haftalık)', '',
    `Veri: ABD para piyasası fonları toplam varlıkları (kamuya açık). Parametreler çalıştırmadan önce yazıldı: pencere 104 hafta, ısınma 52, ≥5 robust sigma, ≥%1 haftalık hareket, tolerans ±7 gün. Çalıştırma: ${new Date().toISOString().slice(0, 10)}.`, '',
    `**Yakalama: ${hit}/${rows.length}**`, '', '| # | Olay | Seri | t0 | Yakalandı | İşaret | Hareket |', '|---|---|---|---|---|---|---|', ...lines, '',
    '## Sınırlar', '- Bu bir **toplam** seridir, fon kesiti değildir; breadth motoru (M21) burada çalışamaz, yani Türkiye\'deki asıl iddia test edilmedi.',
    '- Toplam varlıktaki hareket yönsüzdür: 2008\'de kurumsal fonlara giriş (devlet fonlarına kaçış) çıkış gibi aynı işaretle görünür.',
    '- 3 olay çok küçük örnek. Kurumsal seri 2021\'de bitiyor, SVB (2023) yalnız bireysel seride var.', ''].join('\n');
  console.log(md);
  if (out) { writeFileSync(`${out}.md`, md); writeFileSync(`${out}.json`, JSON.stringify({ params: PARAMS, rows }, null, 2)); }
}
main().catch((e) => { console.error(e); process.exit(1); });
