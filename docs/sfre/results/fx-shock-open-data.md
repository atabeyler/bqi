# Kur şoku motoru: açık veri doğrulaması (FRED H.10)

Veri: ABD Merkez Bankası (FRED) günlük kurları, kamuya açık, anahtarsız. Motor parametreleri değiştirilmedi (pencere 250, ≥5 robust sigma, ≥%2). Olaylar çalıştırmadan önce yazıldı, tolerans ±3 gün. Çalıştırma: 2026-10-02.

**Yakalama: 7/7**

| # | Olay | Seri | t0 | Yakalandı | İşaret | Hareket | Olay dışı işaret/yıl |
|---|---|---|---|---|---|---|---|
| O1 | Meksika peso krizi (Tequila): peso serbest bırakıldı | DEXMXUS | 1994-12-22 | evet | 1994-12-20 | 14.0% | 3.01 |
| O2 | Tayland baht dalgalanmaya bırakıldı | DEXTHUS | 1997-07-02 | evet | 1997-07-01 | -2.5% | 1.84 |
| O3 | Kore won bandı kaldırıldı | DEXKOUS | 1997-12-16 | evet | 1997-12-15 | -8.5% | 1.74 |
| O4 | Brezilya real serbest bırakıldı | DEXBZUS | 1999-01-15 | evet | 1999-01-13 | 9.1% | 2.27 |
| O5 | İsviçre merkez bankası frank tavanını kaldırdı | DEXSZUS | 2015-01-15 | evet | 2015-01-15 | -12.2% | 1.15 |
| O6 | Brexit referandumu (sterlin) | DEXUSUK | 2016-06-24 | evet | 2016-06-24 | -7.8% | 0.7 |
| O7 | Güney Afrika maliye bakanı değişimi ("Nenegate") | DEXSFUS | 2015-12-09 | evet | 2015-12-10 | 4.6% | 1.86 |

## Kontrol serileri (olay listesi yok; her işaret bir stres günü olabilir, yanlış alarm diye etiketlenmedi)

| Seri | Dönem | İşaret sayısı | İşaret/yıl |
|---|---|---|---|
| Japon yeni (DEXJPUS) | 1971-01-04 → 2026-09-25 | 83 | 1.49 |
| Kanada doları (DEXCAUS) | 1971-01-04 → 2026-09-25 | 12 | 0.22 |
| Euro (DEXUSEU) | 1999-01-04 → 2026-09-25 | 9 | 0.32 |
| Avustralya doları (DEXUSAL) | 1971-01-04 → 2026-09-25 | 52 | 0.93 |

Not: Meksika'da işaret 20 Aralık'ta (devalüasyon, bant genişletme), t0 olarak yazdığım 22 Aralık serbest bırakma tarihinden önce; t0 tarihini ben yaklaşık seçmiştim, yani "2 gün önce" gerçek bir erken uyarı değil.

## Sınırlar
- Şoku olduktan sonra tanır, öngörmez; FRED günlük kapanış verisi gün içi gecikmeyi ölçmeye izin vermez.
- Olay seçimi benim; 7 olay küçük bir örnek. Kasıtlı olarak yakalaması kolay (büyük, ani) olaylar ağırlıklı: yavaş krizler (ör. 2013 taper tantrum) bu motorun alanı dışında.
- Bu sonuç modeli kalibre etmez ve Türkiye fon-akış motorlarını (M20/M21) doğrulamaz.
