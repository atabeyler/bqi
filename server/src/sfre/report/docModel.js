import { LEVELS, LEVEL_TR, reportId } from './situationReport.js';

/**
 * Format-neutral document model of a situation report, rendered to PDF and Word by exportFiles.js. The prose here mirrors the HTML report
 * (same numbers, same limits notice); charts are carried as data ("bars"/"line") so each renderer draws what it can.
 */
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d).replace('.', ',')}%` : 'n/a');
const dateTr = (iso) => (iso && String(iso).length >= 10 ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}.${String(iso).slice(0, 4)}` : 'n/a');
const FX_RECENT_DAYS = 5;

export function buildDocModel({ assessment: a, breadth = null, fx = null, meta = {} }) {
  const id = meta.documentId || reportId(a, meta); const gen = meta.generatedAt || new Date().toISOString();
  const bi = a.breadth; const fi = a.fx; const sections = [];
  const rows = [];
  rows.push(['Fon çıkışı yaygınlığı (TEFAS)', bi ? LEVEL_TR[bi.level] : '–', bi ? `${dateTr(bi.date)} haftası: ${pct(bi.breadth)} (${bi.funds ?? '?'} fon izleniyor)` : 'Veri yok']);
  rows.push(['Kur şoku (TCMB EVDS)', fi ? LEVEL_TR[fi.level] : '–', fi ? (fi.lastDate ? `Son veri ${dateTr(fi.lastDate)}; son ${FX_RECENT_DAYS} günde ${fi.recentShocks.length} şok` : 'Veri yok') : 'Veri yok']);
  sections.push({ h: 'Genel Durum', blocks: [{ t: 'status', level: a.level, levelTr: a.levelTr, drivers: a.drivers }, { t: 'table', head: ['Gösterge', 'Seviye', 'Açıklama'], rows, levelCol: 1 }] });
  if (bi) {
    const weeks = (breadth?.weeks || []).slice(-26).map((w) => ({ date: w.date, breadth: w.breadth, flagged: !!w.flagged }));
    sections.push({ h: '1. Fon çıkışı yaygınlığı', blocks: [
      { t: 'p', text: 'Aynı hafta içinde fonların ne kadarının kendi normalinin belirgin altında çıkış yaşadığını gösterir. Tek bir fonun gürültüsü bu ölçüyü bozmaz; piyasa genelinde ortak bir hareket yaygınlığı yükseltir.' },
      { t: 'kpis', items: [{ v: pct(bi.breadth), l: `Son hafta (${dateTr(bi.date)})` }, { v: pct(bi.baseline), l: 'Normal dönem ortalaması' }, { v: pct(bi.alarmLevel), l: 'Alarm seviyesi' }] },
      { t: 'bars', weeks, alarm: bi.alarmLevel },
      { t: 'small', text: `Kırmızı sütunlar alarm üreten haftalardır.${bi.watchLevel !== null ? ` İzleme seviyesi ${pct(bi.watchLevel)} ve üzeridir.` : ''}` },
    ] });
  }
  if (fi && fx?.recent?.length > 1) {
    sections.push({ h: '2. Kur hareketi', blocks: [
      { t: 'p', text: `${fi.series} serisinde günlük hareketin, önceki 250 günün olağan oynaklığına göre büyüklüğü izlenir. Kırmızı noktalar şok günleridir.` },
      { t: 'line', points: fx.recent, flags: (fx.flags || []).map((f) => f.date) },
    ] });
  }
  const cov = (meta.coverage || []).map((c) => [c.source, c.field, String(c.n), dateTr(String(c.first || '').slice(0, 10)), dateTr(String(c.last || '').slice(0, 10))]);
  sections.push({ h: '3. Veri kapsamı', blocks: [{ t: 'table', head: ['Kaynak', 'Alan', 'Gözlem', 'İlk', 'Son'], rows: cov.length ? cov : [['Kayıt yok', '', '', '', '']] }] });
  sections.push({ h: '4. Bakılacaklar', blocks: [
    { t: 'ul', items: a.level === LEVELS.NORMAL ? ['Şu an için bir işlem gerekmiyor; bir sonraki veri güncellemesini bekleyin.'] : ['Çıkışı en yüksek fonların listesini ve para piyasası fonlarındaki hareketi kontrol edin.', 'Kur ve faiz gelişmelerini (TCMB duyuruları, KAP) aynı gün içinde karşılaştırın.', 'Alarm sürerse bir sonraki hafta verisiyle teyit edin; tek haftalık alarm kesin sonuç değildir.'] },
    { t: 'small', text: 'Bu liste yatırım tavsiyesi değildir; incelenecek noktaları gösterir.' },
  ] });
  const models = meta.models || [];
  sections.push({ h: '5. Güvenilirlik ve sınırlar', blocks: [{ t: 'note', text: `Önemli: Bu sistemdeki modeller henüz kalibre edilmemiştir (${models.length ? models.map((m) => `${m.id}: ${m.state}`).join(', ') : 'durum bilgisi yok'}). Fon çıkışı alarmı şu ana kadar yalnız tek bir gerçek olayda (Eylül 2026) test edilmiş ve alarm olayla aynı hafta gelmiştir; erken uyarı süresi kanıtlanmamıştır. Kur şoku tanıma 5 olayın 4'ünde başarılıdır, ancak şoku önceden öngörmez. Bağımsız doğrulama yapılmamıştır. Raporu karar için tek başına dayanak yapmayın.` }] });
  sections.push({ h: '6. Yöntem', blocks: [{ t: 'table', head: ['Konu', 'Açıklama'], rows: [
    ['Fon yaygınlığı', "Her fon için haftalık net akışın kendi medyan/MAD'ine göre z skoru; z ≤ −3 olan fonların payı. Alarm seviyesi referans döneminden öğrenilir (ortalama + 4σ, ortalamanın 2 katı ya da +5 puanın en büyüğü). İzleme seviyesi ortalama + 2σ'dır (kabul edilmiş bir eşik, kalibre değil)."],
    ['Kur şoku', 'Günlük log getirinin önceki 250 günün medyan/MAD\'ine göre ≥ 5 robust sigma ve ≥ %2 olması. Yalnız geçmiş veri kullanılır.'],
    ['Veri', 'TEFAS fon verileri, TCMB EVDS kurları. Gözlemler yayın zamanı damgalıdır; sonradan düzeltmeler eski sonucu değiştirmez.'],
  ] }] });
  return { id, title: 'BFI Durum Raporu', subtitle: 'BOLD FINANCIAL INTELLIGENCE · SİSTEMİK RİSK İZLEME', generatedAt: gen, level: a.level, levelTr: a.levelTr, sections, footer: `BFI Durum Raporu · Belge No ${id} · Otomatik üretilmiştir ve ${gen.slice(0, 10)} tarihine kadar olan veriyi yansıtır. Sürüm ${meta.version || 'n/a'}. Yatırım tavsiyesi değildir.`, dateText: `${dateTr(gen)} ${gen.slice(11, 16)} UTC` };
}

/** Compact, self-sufficient snapshot stored with an archived report so it can be re-rendered as HTML, PDF or Word later. */
export function snapshotOf({ assessment, breadth, fx, meta }) {
  return {
    assessment, meta: { ...meta },
    breadth: breadth ? { funds: breadth.funds ?? null, alarmLevel: breadth.alarmLevel, baseline: breadth.baseline ?? null, weeks: (breadth.weeks || []).slice(-26) } : null,
    fx: fx ? { series: fx.series, flags: (fx.flags || []).slice(-20), recent: fx.recent } : null,
  };
}
