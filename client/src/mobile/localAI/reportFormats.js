const COMMON_RULES = [
  'Kullanıcının verdiği başlık ve konu dışına çıkma.',
  'Geçmiş rapor bağlamı varsa yalnızca biçim/üslup desteği olarak kullan; kullanıcı isteğinde geçmeyen kişi, kurum, olay, banka, proje, silah sistemi veya ülke adını yeni rapora taşıma.',
  'Kategori dışı bölüm üretme; örneğin toplumsal olaylarda optimizasyon tablosu, kuantum anomali, bankacılık, füze veya kaynak tahsisi bölümü yazma.',
  'Canlı haber erişimin yoksa bunu belirt; doğrulanmamış güncel ayrıntıları kesin bilgi gibi büyütme.',
  'Raporu Markdown ile yaz; her bölüm başlığını ## ile başlat.',
];

const FORMATS = {
  savunma: ['## Yönetici Özeti', '## Durum ve Tehdit Değerlendirmesi', '## Risk Matrisi', '## Erken Uyarı Göstergeleri', '## Komuta Kontrol Öncelikleri', '## Acil Eylem Planı', '## Sonuç'],
  enerji: ['## Yönetici Özeti', '## Altyapı ve Arz Güvenliği Durumu', '## Riskler ve Kırılganlıklar', '## Operasyonel Etki', '## Önleyici Tedbirler', '## Sonuç'],
  saldiri: ['## Yönetici Özeti', '## Olay / Kapasite Değerlendirmesi', '## Caydırıcılık ve Eskalasyon Riski', '## Kritik Zafiyetler', '## Müdahale Seçenekleri', '## Sonuç'],
  ekonomi: ['## Yönetici Özeti', '## Piyasa ve Makro Etki', '## Mali Riskler', '## Sektörel Yansımalar', '## Politika Seçenekleri', '## Sonuç'],
  finans: ['## Yönetici Özeti', '## Piyasa ve Makro Etki', '## Mali Riskler', '## Sektörel Yansımalar', '## Politika Seçenekleri', '## Sonuç'],
  toplumsal: ['## Yönetici Özeti', '## Olay Özeti', '## Aktörler ve Taraflar', '## Toplumsal Gerilim Dinamikleri', '## Nefret Söylemi ve Ayrımcılık Riski', '## Kamu Düzeni ve Güvenlik Riski', '## Yerel Yönetim ve Kolluk Değerlendirmesi', '## İletişim ve Önleyici Politika Önerileri', '## Kısa Vadeli Senaryolar', '## Sonuç'],
  danisma: ['## Yönetici Özeti', '## Arka Plan', '## Değerlendirme', '## Seçenekler', '## Tavsiye', '## Sonuç'],
  saglik: ['## Yönetici Özeti', '## Sağlık Riski Değerlendirmesi', '## Kapasite ve Hazırlık', '## Kırılgan Gruplar', '## Müdahale Önerileri', '## Sonuç'],
  'cok-alanli': ['## Yönetici Özeti', '## Alanlar Arası Etkileşim', '## Zincirleme Riskler', '## Önceliklendirme', '## Koordinasyon Planı', '## Sonuç'],
  bddk: ['## Yönetici Özeti', '## Finansal İşlem / Kurum Riski', '## Anomali Göstergeleri', '## Uyum ve Denetim Bulguları', '## Önerilen Aksiyonlar', '## Sonuç'],
  btk: ['## Yönetici Özeti', '## Telekom / Ağ Olayı Özeti', '## Anomali ve Dolandırıcılık Göstergeleri', '## Teknik Riskler', '## Müdahale Önerileri', '## Sonuç'],
};

const DEFAULT_FORMAT = ['## Yönetici Özeti', '## Durum Değerlendirmesi', '## Riskler', '## Öneriler', '## Sonuç'];

export function getReportSections(category = '') {
  return FORMATS[category] || DEFAULT_FORMAT;
}

export function getReportFormat(category = '') {
  const sections = getReportSections(category);
  return [
    'Cevabın ilk satırı tam olarak şu olmalı:',
    sections[0],
    '',
    'Rapor sadece aşağıdaki Markdown başlıklarından oluşmalı:',
    ...sections.map((section) => section),
    '',
    'Zorunlu kurallar:',
    ...COMMON_RULES.map((rule) => `- ${rule}`),
  ].join('\n');
}

export function cleanReportOutput(content = '', category = '') {
  const sections = getReportSections(category);
  const firstSection = sections[0];
  let cleaned = String(content || '').trim();
  const firstIndex = cleaned.toLocaleLowerCase('tr-TR').indexOf(firstSection.toLocaleLowerCase('tr-TR'));
  if (firstIndex > 0) {
    cleaned = cleaned.slice(firstIndex).trim();
  }

  if (category === 'toplumsal') {
    cleaned = cleaned
      .replace(/^(?:#{1,3}\s*)?(?:OPTİMİZASYON PROBLEMİ|OPTIMIZASYON PROBLEMI|QAOA)[\s\S]*?(?=^#{1,3}\s*(?:Yönetici Özeti|Olay Özeti|Aktörler ve Taraflar|Toplumsal Gerilim Dinamikleri|Nefret Söylemi ve Ayrımcılık Riski|Kamu Düzeni ve Güvenlik Riski|Yerel Yönetim ve Kolluk Değerlendirmesi|İletişim ve Önleyici Politika Önerileri|Kısa Vadeli Senaryolar|Sonuç)|(?![\s\S]))/gmi, '')
      .trim();
  }

  return cleaned;
}

// A weak/low-tier local model under-following instructions doesn't fail
// loudly -- it echoes the prompt itself back as its "answer" (getReportFormat
// above starts with the same first section header cleanReportOutput searches
// for, so that cleanup can't tell a real report from an echoed prompt that
// happens to start at the same header). These phrases only ever appear in
// the instruction text this module builds, never in genuine report prose,
// so their presence after cleaning is a reliable echo signal.
const PROMPT_ECHO_MARKERS = [
  'zorunlu kurallar',
  'rapor sadece aşağıdaki markdown başlıklarından oluşmalı',
  'cevabın ilk satırı tam olarak',
];

export function isPromptEcho(content = '') {
  const normalized = String(content || '').toLocaleLowerCase('tr-TR');
  return PROMPT_ECHO_MARKERS.some((marker) => normalized.includes(marker));
}

export const _internal = { FORMATS, COMMON_RULES };
