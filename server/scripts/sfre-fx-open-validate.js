/**
 * Open-data validation of the daily FX shock engine on public FRED (Federal Reserve H.10) series.
 * Events and parameters are fixed BEFORE running (default engine params, tolerance +-3 days) and results are published whatever they are.
 * Usage: node scripts/sfre-fx-open-validate.js [--out docs/sfre/results/fx-shock-open-data]
 */
import { writeFileSync } from 'node:fs';
import { detectFxShocks, scoreEvents } from '../src/sfre/engines/fxShock.js';

// series = FRED id; value = local currency per USD, except GBP/EUR style (USD per local) where a USD *rise* is a local fall; the engine is symmetric (|z|), so direction does not matter.
export const OPEN_EVENTS = [
  { id: 'O1', series: 'DEXMXUS', t0: '1994-12-22', name: 'Meksika peso krizi (Tequila): peso serbest bırakıldı' },
  { id: 'O2', series: 'DEXTHUS', t0: '1997-07-02', name: 'Tayland baht dalgalanmaya bırakıldı' },
  { id: 'O3', series: 'DEXKOUS', t0: '1997-12-16', name: 'Kore won bandı kaldırıldı' },
  { id: 'O4', series: 'DEXBZUS', t0: '1999-01-15', name: 'Brezilya real serbest bırakıldı' },
  { id: 'O5', series: 'DEXSZUS', t0: '2015-01-15', name: 'İsviçre merkez bankası frank tavanını kaldırdı' },
  { id: 'O6', series: 'DEXUSUK', t0: '2016-06-24', name: 'Brexit referandumu (sterlin)' },
  { id: 'O7', series: 'DEXSFUS', t0: '2015-12-09', name: 'Güney Afrika maliye bakanı değişimi ("Nenegate")' },
];
export const CONTROL_SERIES = [['DEXJPUS', 'Japon yeni'], ['DEXCAUS', 'Kanada doları'], ['DEXUSEU', 'Euro'], ['DEXUSAL', 'Avustralya doları']];

async function fred(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`); if (!res.ok) throw new Error(`${id} HTTP ${res.status}`);
  const pts = []; for (const line of (await res.text()).split('\n').slice(1)) { const [date, v] = line.trim().split(','); const value = Number(v); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && v && v !== '.' && Number.isFinite(value) && value > 0) pts.push({ date, value }); }
  return pts;
}

async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const cache = new Map(); const get = async (id) => { if (!cache.has(id)) cache.set(id, await fred(id)); return cache.get(id); };
  const rows = [];
  for (const e of OPEN_EVENTS) {
    const pts = await get(e.series); const det = detectFxShocks(pts); const sc = scoreEvents(det.flags, [e]);
    const years = (Date.parse(pts.at(-1).date) - Date.parse(pts[0].date)) / (365.25 * 86400000);
    rows.push({ ...sc.events[0], series: e.series, days: pts.length, from: pts[0].date, to: pts.at(-1).date, flagsOutsideEvent: sc.unmatchedFlags.length, flagsPerYear: +(sc.unmatchedFlags.length / years).toFixed(2) });
  }
  const controls = [];
  for (const [id, label] of CONTROL_SERIES) {
    const pts = await get(id); const det = detectFxShocks(pts); const years = (Date.parse(pts.at(-1).date) - Date.parse(pts[0].date)) / (365.25 * 86400000);
    controls.push({ series: id, label, from: pts[0].date, to: pts.at(-1).date, flags: det.flags.length, flagsPerYear: +(det.flags.length / years).toFixed(2), dates: det.flags.map((f) => f.date) });
  }
  const hit = rows.filter((r) => r.detected).length;
  const md = [
    '# Kur şoku motoru: açık veri doğrulaması (FRED H.10)', '',
    `Veri: ABD Merkez Bankası (FRED) günlük kurları, kamuya açık, anahtarsız. Motor parametreleri değiştirilmedi (pencere 250, ≥5 robust sigma, ≥%2). Olaylar çalıştırmadan önce yazıldı, tolerans ±3 gün. Çalıştırma: ${new Date().toISOString().slice(0, 10)}.`, '',
    `**Yakalama: ${hit}/${rows.length}**`, '',
    '| # | Olay | Seri | t0 | Yakalandı | İşaret | Hareket | Olay dışı işaret/yıl |', '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.name} | ${r.series} | ${r.t0} | ${r.detected ? 'evet' : '**hayır**'} | ${r.flagDate ?? '–'} | ${r.move == null ? '–' : `${(r.move * 100).toFixed(1)}%`} | ${r.flagsPerYear} |`), '',
    '## Kontrol serileri (olay listesi yok; her işaret bir stres günü olabilir, yanlış alarm diye etiketlenmedi)', '',
    '| Seri | Dönem | İşaret sayısı | İşaret/yıl |', '|---|---|---|---|', ...controls.map((c) => `| ${c.label} (${c.series}) | ${c.from} → ${c.to} | ${c.flags} | ${c.flagsPerYear} |`), '',
    '## Sınırlar', '- Şoku olduktan sonra tanır, öngörmez; FRED günlük kapanış verisi gün içi gecikmeyi ölçmeye izin vermez.',
    '- Olay seçimi benim; 7 olay küçük bir örnek. Kasıtlı olarak yakalaması kolay (büyük, ani) olaylar ağırlıklı: yavaş krizler (ör. 2013 taper tantrum) bu motorun alanı dışında.',
    '- Bu sonuç modeli kalibre etmez ve Türkiye fon-akış motorlarını (M20/M21) doğrulamaz.', '',
  ].join('\n');
  console.log(md);
  if (out) { writeFileSync(`${out}.md`, md); writeFileSync(`${out}.json`, JSON.stringify({ rows, controls }, null, 2)); }
}
main().catch((e) => { console.error(e); process.exit(1); });
