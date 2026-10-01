# SFRE — Veri Kaynakları Araştırması (2026-10-01)

Yöntem: web araması + resmi sayfa/PDF okuma. **Hiçbir kaynağa bağlanılmadı, hiçbir veri indirilmedi, hiçbir API anahtarı alınmadı.** "Doğrulandı" = resmi sayfada okundu; "iddia" = ikincil kaynak.

| İhtiyaç | Kaynak | Durum | Erişim | SFRE'de karşılığı |
|---|---|---|---|---|
| KAP bildirimleri, ekler, şirket/fon listesi, ISIN | MKK **KAP Veri Yayın Servisi (REST)**: `disclosures`, `disclosureDetail`, `downloadAttachment`, `lastDisclosureIndex`, `members`, `memberDetail`, `funds`, `fundDetail`, `memberSecurities`, `blockedDisclosures`, `caEventStatus` | Doğrulandı ([MKK PDF](https://kap.org.tr/tr/api/about/content-file/8a019492945fbe080194b26d8bed4873)) | **Önce Borsa İstanbul A.Ş. ile veri dağıtım sözleşmesi**, sonra MKK yetkilendirmesi, IP bazlı, API KEY e-posta ile. Başvuru: kapdestek@mkk.com.tr. MKK haberi ([MKK API Portal](https://www.mkk.com.tr/haberler/mkk-api-portal-yayinda)) "ücretsiz, hesap + onay + API Key" diyor; PDF ise sözleşme şartı koyuyor → **çelişki, MKK'ya sorulmalı**. | `official:kap` (`JsonFeedProvider` + adaptör gerekli); disclosure/claim motorları |
| Fon NAV, pay sayısı, yatırımcı sayısı, portföy büyüklüğü, varlık sınıfı dağılımı | TEFAS Tarihsel Veriler sayfası | Doğrulandı (ikincil çalışma: elle Excel indirme, sorgu boyutu sınırı nedeniyle parça parça) | Kamuya açık, API değil; otomatik çekim/ToS **doğrulanmadı** | `FUND:*` flow serileri, β tahmini |
| Fon **hisse bazlı** portföy (overlap/cascade için kritik) | KAP fon bildirimleri (portföy dağılım raporları) / MKK `fundDetail` | **Kapsam doğrulanmadı** (hangi periyot/ayrıntı?) | KAP API ile | `holdings` gözlemleri |
| BIST günlük OHLCV tarihsel | Borsa İstanbul Veri Yayın Ürünleri: Gün Sonu Verileri, "Geçmişe Dönük Veri Satışı" | Doğrulandı ([BIST](https://www.borsaistanbul.com/veriler/veri-yayini/veri-yayin-urunleri)) | **Ücretli/lisanslı**, veri dağıtıcıları üzerinden; fiyat BIST ile görüşülmeli | `close`/`volume` → mikroyapı, Amihud, ADV |
| Fiili dolaşım (free float) | MKK / BIST "Fiili Dolaşımda Bulunan Paylar Raporu" | Doğrulandı; iddia: 15 Haz 2026'dan beri MKK günlük hesaplıyor ([BloombergHT](https://www.bloomberght.com/borsada-fiili-dolasim-yeniden-hesaplandi-3780042), okunmadı) | MKK genel mektup sayfası ([MKK](https://www.mkk.com.tr/tr-tr/Genel-Mektuplar/Sayfalar/Fiili-Dolasim-Pay-Orani.aspx)); veri erişim yolu doğrulanmadı | `free_float_shares` → free-float exposure |
| Bilanço/gelir tablosu (filing-time) | KAP finansal raporlar (MKK API) | Kapsam doğrulanmadı | KAP API | fundamentals/accounting |
| SPK bülten, işlem yasakları, tedbirler | spk.gov.tr | **Bu oturumda incelenmedi** | Kamuya açık sayfa varsayımı, doğrulanmadı | market-integrity golden cases |
| Kaldıraç / repo / türev / karşı-taraf | — | **Kamuya açık kaynak bulunamadı** | — | UNOBSERVED kalır (sıfır varsayılmaz) |
| Attention (haber/arama) | — | Araştırılmadı | — | `attention` |

## Yetkisiz yollar (kullanılmadı, önerilmez)
RapidAPI/Apify/GitHub "TEFAS scraper"ları ve gayri resmi JSON uçları: sözleşme/ToS durumu ve PIT zaman damgası (`available_time`) garantisi yok. Kurumsal denetim için kullanılmamalı.

## Kritik PIT uyarısı
TEFAS/KAP verileri **geriye dönük düzeltilebilir**; `available_time` yayın anından alınmalı (KAP bildirim zamanı), sonradan indirilen tarihsel dosyaların indirme tarihi değil. TEFAS Excel dosyaları yayın gecikmesi taşımaz → `available_time` için muhafazakâr gecikme (ör. T+1) belgelenmeli. Aksi halde look-ahead sızar.

## Önerilen sıra
1. kapdestek@mkk.com.tr + Borsa İstanbul veri dağıtımı: KAP API koşulları, fon portföy detayı kapsamı, tarihsel derinlik, maliyet.
2. BIST'ten Gün Sonu + Fiili Dolaşım tarihsel paket fiyat teklifi (≥2024 öncesi 2025 Q4 → 2026 Eylül yeterli golden case için).
3. TEFAS tarihsel veri kullanım koşullarının yazılı teyidi.
4. Gelince: `official:kap` için `JsonFeedProvider` adaptörü + PIT ingestion + TR-FUND-2026-001 replay.
