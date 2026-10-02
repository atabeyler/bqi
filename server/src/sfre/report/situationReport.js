import { createHash } from 'node:crypto';

/**
 * Situation report: turns the latest evidence (fund breadth results, FX shocks, data coverage, model governance) into one
 * level (NORMAL / İZLEME / ALARM), the reasons for it, and a printable HTML document. Pure functions, no I/O.
 * The WATCH tier (breadth >= mean + 2 sd of the reference) is a documented convention, not a calibrated rate.
 */
export const LEVELS = Object.freeze({ NORMAL: 0, WATCH: 1, ALARM: 2 });
export const LEVEL_TR = Object.freeze({ 0: 'NORMAL', 1: 'İZLEME', 2: 'ALARM' });
const FX_RECENT_DAYS = 5;
const DAY = 86400000;
const COLORS = { 0: '#1b7f4b', 1: '#b7791f', 2: '#b42318' };

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d).replace('.', ',')}%` : 'n/a');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateTr = (iso) => (iso && iso.length >= 10 ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : 'n/a');

/** breadth: payload of a breadth trial ({weeks, alarmLevel, baseline, funds}); fx: {series, flags, recent:[{date,value}]}. Either may be missing. */
export function assessSituation({ breadth = null, fx = null, now = new Date() } = {}) {
  const drivers = []; let level = LEVELS.NORMAL; const raise = (l) => { if (l > level) level = l; };
  let breadthInfo = null;
  const w = breadth?.weeks?.length ? breadth.weeks[breadth.weeks.length - 1] : null;
  if (w && Number.isFinite(w.breadth) && Number.isFinite(breadth.alarmLevel)) {
    const m = breadth.baseline?.meanBreadth; const s = breadth.baseline?.sdBreadth; const watchAt = Number.isFinite(m) && Number.isFinite(s) ? m + 2 * s : null;
    const stale = (now.getTime() - Date.parse(`${w.date}T00:00:00Z`)) / DAY;
    const st = w.flagged ? LEVELS.ALARM : (watchAt !== null && w.breadth >= watchAt ? LEVELS.WATCH : LEVELS.NORMAL);
    breadthInfo = { date: w.date, breadth: w.breadth, alarmLevel: breadth.alarmLevel, watchLevel: watchAt, baseline: m ?? null, level: st, funds: breadth.funds ?? null, staleDays: Math.round(stale) };
    raise(st);
    if (st === LEVELS.ALARM) drivers.push(`Fonların ${pct(w.breadth)} kadarı aynı anda kendi normalinin belirgin altında çıkış gösteriyor (alarm seviyesi ${pct(breadth.alarmLevel)}, normal dönem ortalaması ${pct(m)}).`);
    else if (st === LEVELS.WATCH) drivers.push(`Çıkış gösteren fon payı ${pct(w.breadth)}; alarm seviyesinin (${pct(breadth.alarmLevel)}) altında ama normalin üzerinde (ortalama ${pct(m)}).`);
    if (stale > 14) drivers.push(`Fon verisi ${Math.round(stale)} gün eski; bu bölümün güncel olduğu söylenemez.`);
  }
  let fxInfo = null;
  if (fx?.flags) {
    const last = fx.recent?.length ? fx.recent[fx.recent.length - 1].date : null;
    const recent = last ? fx.flags.filter((f) => (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${f.date}T00:00:00Z`)) / DAY <= FX_RECENT_DAYS) : [];
    fxInfo = { series: fx.series, lastDate: last, recentShocks: recent, level: recent.length ? LEVELS.ALARM : LEVELS.NORMAL };
    raise(fxInfo.level);
    for (const f of recent) drivers.push(`${dateTr(f.date)} tarihinde kurda ${pct(f.move)} hareket (olağan oynaklığın ${Math.abs(f.z)} katı).`);
  }
  if (!breadthInfo && !fxInfo) drivers.push('Değerlendirilecek veri yok.');
  if (level === LEVELS.NORMAL && (breadthInfo || fxInfo)) drivers.unshift('Hiçbir gösterge alışılmadık bir hareket göstermiyor.');
  return { level, levelTr: LEVEL_TR[level], drivers, breadth: breadthInfo, fx: fxInfo };
}

function breadthChart(b, weeks) {
  const data = (weeks || []).slice(-26); if (data.length < 2) return '';
  const W = 640; const H = 170; const pad = { l: 40, r: 10, t: 12, b: 26 };
  const max = Math.max(b.alarmLevel * 1.4, ...data.map((d) => d.breadth)); const bw = (W - pad.l - pad.r) / data.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const bars = data.map((d, i) => `<rect x="${(pad.l + i * bw + 1).toFixed(1)}" y="${y(d.breadth).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - pad.b - y(d.breadth)).toFixed(1)}" fill="${d.flagged ? COLORS[2] : '#5b7db1'}"><title>${esc(d.date)}: ${pct(d.breadth)}</title></rect>`).join('');
  const ticks = [0, 0.5, 1].map((f) => `<text x="${pad.l - 6}" y="${(y(max * f) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#667085">${pct(max * f, 0)}</text>`).join('');
  const ay = y(b.alarmLevel).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Haftalık çıkış yaygınlığı" style="width:100%;height:auto">${ticks}${bars}<line x1="${pad.l}" x2="${W - pad.r}" y1="${ay}" y2="${ay}" stroke="${COLORS[2]}" stroke-dasharray="4 3"/><text x="${W - pad.r}" y="${(y(b.alarmLevel) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="${COLORS[2]}">alarm seviyesi ${pct(b.alarmLevel)}</text><text x="${pad.l}" y="${H - 8}" font-size="9" fill="#667085">${dateTr(data[0].date)}</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end" font-size="9" fill="#667085">${dateTr(data[data.length - 1].date)}</text></svg>`;
}

function fxChart(fx) {
  const pts = fx?.recent || []; if (pts.length < 2) return '';
  const W = 640; const H = 150; const pad = { l: 44, r: 10, t: 10, b: 24 };
  const vs = pts.map((p) => p.value); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
  const x = (i) => pad.l + ((W - pad.l - pad.r) * i) / (pts.length - 1); const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / span);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const marks = (fx.flags || []).map((f) => { const i = pts.findIndex((p) => p.date === f.date); return i < 0 ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(pts[i].value).toFixed(1)}" r="3.5" fill="${COLORS[2]}"><title>${esc(f.date)}</title></circle>`; }).join('');
  const num = (v) => v.toFixed(2).replace('.', ',');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kur seyri" style="width:100%;height:auto"><path d="${d}" fill="none" stroke="#1d4e89" stroke-width="1.6"/>${marks}<text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" font-size="9" fill="#667085">${num(hi)}</text><text x="${pad.l - 6}" y="${H - pad.b}" text-anchor="end" font-size="9" fill="#667085">${num(lo)}</text><text x="${pad.l}" y="${H - 8}" font-size="9" fill="#667085">${dateTr(pts[0].date)}</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end" font-size="9" fill="#667085">${dateTr(pts[pts.length - 1].date)}</text></svg>`;
}

/** Stable short document id: same inputs give the same id, so a printed copy can be matched to the stored evidence. */
export function reportId(assessment, meta) { return createHash('sha256').update(JSON.stringify({ a: assessment, d: meta?.dataAsOf ?? null, g: meta?.generatedAt ?? null })).digest('hex').slice(0, 12).toUpperCase(); }

const CSS = `@page{size:A4;margin:16mm 14mm}*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:#1d2433;font:13px/1.55 "Segoe UI",system-ui,-apple-system,Arial,sans-serif}
.page{max-width:820px;margin:20px auto;background:#fff;padding:36px 44px;box-shadow:0 1px 12px rgba(16,24,40,.12)}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0b2545;padding-bottom:12px}
.brand{font-size:26px;font-weight:700;letter-spacing:.14em;color:#0b2545}.brand small{display:block;font-size:10px;font-weight:500;letter-spacing:.12em;color:#667085}
.meta{text-align:right;font-size:11px;color:#667085}h1{font-size:19px;margin:22px 0 4px;color:#0b2545}h2{font-size:14px;margin:26px 0 8px;color:#0b2545;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #d0d5dd;padding-bottom:4px}
.status{display:flex;gap:18px;align-items:center;border:1px solid #d0d5dd;border-radius:6px;padding:14px 18px;margin:14px 0}
.status .lv{font-size:26px;font-weight:700;min-width:130px}.status ul{margin:0;padding-left:18px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}th,td{border-bottom:1px solid #e4e7ec;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f6f9;color:#344054;font-weight:600}
.chip{display:inline-block;color:#fff;font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:10px}
.note{background:#fff8e6;border:1px solid #f0d58a;border-radius:6px;padding:10px 14px;font-size:12px}.small{font-size:11px;color:#667085}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0}.kpi{border:1px solid #e4e7ec;border-radius:6px;padding:10px 12px}.kpi b{display:block;font-size:20px;color:#0b2545}.kpi span{font-size:11px;color:#667085}
footer{margin-top:30px;border-top:1px solid #d0d5dd;padding-top:10px;font-size:10.5px;color:#667085}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}h2{break-after:avoid}table,.status,.kpi,svg{break-inside:avoid}}`;

export function renderReportHtml({ assessment, breadth = null, fx = null, meta = {} }) {
  const a = assessment; const id = reportId(a, meta); const col = COLORS[a.level]; const gen = meta.generatedAt || new Date().toISOString();
  const models = meta.models || []; const cov = meta.coverage || []; const bi = a.breadth; const fi = a.fx;
  const chip = (l) => `<span class="chip" style="background:${COLORS[l]}">${LEVEL_TR[l]}</span>`;
  const row = (name, l, text) => `<tr><td>${esc(name)}</td><td>${chip(l)}</td><td>${esc(text)}</td></tr>`;
  const watchNote = bi && bi.watchLevel !== null ? ` İzleme seviyesi ${pct(bi.watchLevel)} ve üzeridir.` : '';
  const sec1 = bi ? `<h2>1. Fon çıkışı yaygınlığı</h2><p>Aynı hafta içinde fonların ne kadarının kendi normalinin belirgin altında çıkış yaşadığını gösterir. Tek bir fonun gürültüsü bu ölçüyü bozmaz; piyasa genelinde ortak bir hareket yaygınlığı yükseltir.</p>
<div class="grid"><div class="kpi"><b>${pct(bi.breadth)}</b><span>Son hafta (${dateTr(bi.date)})</span></div><div class="kpi"><b>${pct(bi.baseline)}</b><span>Normal dönem ortalaması</span></div><div class="kpi"><b>${pct(bi.alarmLevel)}</b><span>Alarm seviyesi</span></div></div>
${breadthChart(bi, breadth?.weeks)}<p class="small">Kırmızı sütunlar alarm üreten haftalardır.${watchNote}</p>` : '';
  const sec2 = fi ? `<h2>2. Kur hareketi</h2><p>${esc(fi.series)} serisinde günlük hareketin, önceki 250 günün olağan oynaklığına göre büyüklüğü izlenir. Kırmızı noktalar şok günleridir.</p>${fxChart(fx)}` : '';
  const covRows = cov.length ? cov.map((c) => `<tr><td>${esc(c.source)}</td><td>${esc(c.field)}</td><td>${esc(c.n)}</td><td>${esc(dateTr(String(c.first || '').slice(0, 10)))}</td><td>${esc(dateTr(String(c.last || '').slice(0, 10)))}</td></tr>`).join('') : '<tr><td colspan="5">Kayıt yok</td></tr>';
  const todo = a.level === LEVELS.NORMAL
    ? '<li>Şu an için bir işlem gerekmiyor; bir sonraki veri güncellemesini bekleyin.</li>'
    : '<li>Çıkışı en yüksek fonların listesini ve para piyasası fonlarındaki hareketi kontrol edin.</li><li>Kur ve faiz gelişmelerini (TCMB duyuruları, KAP) aynı gün içinde karşılaştırın.</li><li>Alarm sürerse bir sonraki hafta verisiyle teyit edin; tek haftalık alarm kesin sonuç değildir.</li>';
  const modelText = models.length ? models.map((m) => `${esc(m.id)}: ${esc(m.state)}`).join(', ') : 'durum bilgisi yok';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BFI Durum Raporu ${esc(id)}</title><style>${CSS}</style></head><body><div class="page">
<header><div class="brand">BFI<small>BOLD FINANCIAL INTELLIGENCE · SİSTEMİK RİSK İZLEME</small></div><div class="meta">Durum Raporu<br>Belge No: <b>${esc(id)}</b><br>Üretim: ${esc(dateTr(gen))} ${esc(gen.slice(11, 16))} UTC</div></header>
<h1>Genel Durum</h1>
<div class="status" style="border-left:8px solid ${col}"><div class="lv" style="color:${col}">${esc(a.levelTr)}</div><div><ul>${a.drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div></div>
<table><thead><tr><th>Gösterge</th><th>Seviye</th><th>Açıklama</th></tr></thead><tbody>
${bi ? row('Fon çıkışı yaygınlığı (TEFAS)', bi.level, `${dateTr(bi.date)} haftası: ${pct(bi.breadth)} (${bi.funds ?? '?'} fon izleniyor)`) : '<tr><td>Fon çıkışı yaygınlığı (TEFAS)</td><td colspan="2">Veri yok</td></tr>'}
${fi ? row('Kur şoku (TCMB EVDS)', fi.level, fi.lastDate ? `Son veri ${dateTr(fi.lastDate)}; son ${FX_RECENT_DAYS} günde ${fi.recentShocks.length} şok` : 'Veri yok') : '<tr><td>Kur şoku (TCMB EVDS)</td><td colspan="2">Veri yok</td></tr>'}
</tbody></table>
${sec1}${sec2}
<h2>3. Veri kapsamı</h2>
<table><thead><tr><th>Kaynak</th><th>Alan</th><th>Gözlem</th><th>İlk</th><th>Son</th></tr></thead><tbody>${covRows}</tbody></table>
<h2>4. Bakılacaklar</h2><ul>${todo}</ul><p class="small">Bu liste yatırım tavsiyesi değildir; incelenecek noktaları gösterir.</p>
<h2>5. Güvenilirlik ve sınırlar</h2>
<div class="note"><b>Önemli:</b> Bu sistemdeki modeller henüz kalibre edilmemiştir (${modelText}). Fon çıkışı alarmı şu ana kadar yalnız tek bir gerçek olayda (Eylül 2026) test edilmiş ve alarm olayla aynı hafta gelmiştir; erken uyarı süresi kanıtlanmamıştır. Kur şoku tanıma 5 olayın 4'ünde başarılıdır, ancak şoku önceden öngörmez. Bağımsız doğrulama yapılmamıştır. Raporu karar için tek başına dayanak yapmayın.</div>
<h2>6. Yöntem</h2>
<table><tbody><tr><th style="width:30%">Fon yaygınlığı</th><td>Her fon için haftalık net akışın kendi medyan/MAD'ine göre z skoru; z ≤ −3 olan fonların payı. Alarm seviyesi referans döneminden öğrenilir (ortalama + 4σ, ortalamanın 2 katı ya da +5 puanın en büyüğü). İzleme seviyesi ortalama + 2σ'dır (kabul edilmiş bir eşik, kalibre değil).</td></tr>
<tr><th>Kur şoku</th><td>Günlük log getirinin önceki 250 günün medyan/MAD'ine göre ≥ 5 robust sigma ve ≥ %2 olması. Yalnız geçmiş veri kullanılır.</td></tr>
<tr><th>Veri</th><td>TEFAS fon verileri, TCMB EVDS kurları. Gözlemler yayın zamanı damgalıdır; sonradan düzeltmeler eski sonucu değiştirmez.</td></tr></tbody></table>
<footer>BFI Durum Raporu · Belge No ${esc(id)} · Otomatik üretilmiştir ve ${esc(gen.slice(0, 10))} tarihine kadar olan veriyi yansıtır. Sürüm ${esc(meta.version || 'n/a')}. Yatırım tavsiyesi değildir.</footer>
</div></body></html>`;
}
