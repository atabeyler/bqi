# Olay kataloğu (Faz 2: gerçek olay testi için TASLAK)

Amaç: BFI motorlarının gerçek stres olaylarında ne zaman ve ne dediğini önceden yazılmış protokolle ölçmek. **Bu liste bir taslaktır: tarihler ve etiketler proje sahibi tarafından doğrulanmalıdır.** Doğrulanmamış hiçbir olay teste girmez.

## Kural (sonuca bakmadan sabit)

1. Her olay için tek bir **başlangıç tarihi** (`t0`) ve kaynağı (haber/ resmî duyuru bağlantısı) yazılır.
2. Motor, `t0`'dan **önceki** veriyle kalibre edilir. `t0` sonrası veri kalibrasyona giremez.
3. Ölçütler: ilk sistem seviyesi alarmın tarihi (erken uyarı süresi = `t0` − alarm), olay dışı dönemlerdeki yanlış alarm sayısı/yıl, alarmın kapsadığı fon payı.
4. Sonuçlar olumsuz olsa da yayımlanır (olumsuz sonuç da bulgudur).

## Aday olaylar (doğrulanacak)

| # | Olay | Aday t0 | Türü | Veri gereksinimi | Doğrulama |
|---|---|---|---|---|---|
| E1 | Ağustos 2018 kur şoku (TL sert değer kaybı) | 2018-08-10 | Kur / bankacılık | TEFAS 2018, BIST, TCMB kur | ☐ sen |
| E2 | Covid-19 piyasa çöküşü | 2020-03-09 | Küresel likidite | TEFAS 2020, BIST | ☐ sen |
| E3 | Merkez Bankası başkanı değişimi, piyasa şoku | 2021-03-22 | Kur / yerel | TEFAS 2021, TCMB kur | ☐ sen |
| E4 | Aralık 2021 kur şoku | 2021-12-14 | Kur | TEFAS 2021, TCMB kur | ☐ sen |
| E5 | Şubat 2023 depremi sonrası borsa kapanışı | 2023-02-06 | Dışsal şok | TEFAS 2023, BIST | ☐ sen |
| E6 | Mayıs 2023 seçim dönemi dalgalanması | 2023-05-14 | Siyasi / kur | TEFAS 2023, BIST, TCMB kur | ☐ sen |
| E7 | Mart 2025 siyasi gelişme sonrası dalgalanma | 2025-03-19 | Siyasi / likidite | TEFAS 2025, BIST, TCMB kur | ☐ sen |
| E8 | Eylül 2026 toplu fon çıkışı (veride görülen) | ~2026-09-17 | Fon akışı | TEFAS (var) | ☐ sen: **nedenini ve tarihini doğrula** |

Notlar:
- E1–E7, bilinen kamuya açık olaylardır; ancak tarihlerin kesin gün ve gösterge tanımlarının **kaynakla teyit edilmesi** gerekir.
- E8 veride (Eylül 2026) görülen toplu çıkıştır (fon büyüklüğü ağırlıklı net akış ≈ −%4,4); **nedeni bu belgede bilinmemektedir**.
- Eşiklerin doğru kalibrasyonu için en az 3–5 bağımsız olay hedeflenir; küçük örneklem nedeniyle sonuçlar "kanıt düzeyi" etiketiyle raporlanır.

## Gerekli veri (olay başına)

| Veri | Kaynak | Durum |
|---|---|---|
| TEFAS fon akışı (2018–2025) | TEFAS arayüzü (aylık 1 ay sınırı) | Şu an yalnızca Eyl 2025 → Eyl 2026 var |
| BIST günlük fiyat | Borsa İstanbul DataStore | Yok (lisans) |
| Kur, faiz, makro | TCMB EVDS (ücretsiz API anahtarı) | Yok (anahtar gerekli) |
| Fon portföyü | KAP / MKK API | Yok (başvuru) |

## Sen yapacaksın: kontrol listesi

- [ ] Her aday olayın tarihini ve kaynağını teyit et, listeden çıkar/ekle.
- [ ] **TCMB EVDS:** evds2.tcmb.gov.tr → ücretsiz hesap → profil sayfasından **API anahtarı** al. Anahtarı `server/.env` içine `TCMB_EVDS_KEY=` olarak yaz (sohbete yazma).
- [ ] **MKK API Portal:** apiportal.mkk.com.tr → Kayıt Ol → hesap onayı → uygulama oluştur (API anahtarı üretir) → KAP Veri Yayın Servisi ürününe kaydol. Başvuru taslağı: `DATA_REQUESTS.md`.
- [ ] **Borsa İstanbul DataStore:** datastore.borsaistanbul.com → giriş yap → Pay Piyasası Verileri → günlük fiyat paketinin fiyat ve abonelik koşullarını bana bildir (satın alma kararı sende).
