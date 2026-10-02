# Kur şoku motoru: olay kataloğu sonucu (3 Ekim 2026)

Veri: TCMB EVDS USD/TRY göstergesel alış kuru, 2018-01-01 → 2026-10-02, 2.198 işlem günü (bulutta, `GET /api/sfre/data/fx-shocks`).
Motor: `server/src/sfre/engines/fxShock.js`. Gün, önceki 250 getirinin medyan/MAD'ına göre ≥5 robust sigma **ve** ≥%2 hareketse şoktur; yalnız geçmiş veri kullanılır, ilk 60 gün işaretlenmez. Parametreler sonuçlara bakmadan seçildi, **ayarlanmadı**.

| Olay | t0 | Yakalandı | İşaret tarihi | Hareket | Not |
|---|---|---|---|---|---|
| E1 Ağustos 2018 | 2018-08-10 | evet | 2018-08-13 | +%10 | Cuma şoku, ilk işlem günü işaretlendi |
| E3 Ağbal | 2021-03-22 | evet | 2021-03-23 | +%8,8 | |
| E4 Aralık 2021 | 2021-12-16 | evet | 2021-12-17 | +%3,9 | asıl sıçrama 20–21 Aralık (+%7,4/+%7,0), o günler de işaretli |
| E6 Seçim | 2023-05-15 | **hayır** | – | – | Kur o gün kontrollü tutuldu; şok 8 Haziran'da (+%7,3) göründü |
| E7 İmamoğlu | 2025-03-19 | evet | 2025-03-20 | +%3,8 | |

Sonuç: 5 olaydan 4'ü yakalandı, 1'i kaçırıldı (E6).

## Dürüst sınırlar

- **Süre ölçümü anlamlı değil.** EVDS günlük değeri bir sonraki veri gününe düşüyor (kayıt tarihi ≠ piyasa hareketi günü) ve veri `+1 gün` gecikmeyle kullanılabilir sayılıyor. "−1 ile −3 gün" bu yüzden gerçek gecikme değil, serinin tarih kuralıdır. Gün içi veri olmadan "önceden uyarı" iddia edilemez; bu motor **şoku olduğunda tanır, öngörmez**.
- **Yanlış alarm sayılamıyor.** Katalog dışı 32 işaretin çoğu gerçek stres kümeleri (Ağustos 2018 sonrası, Kasım–Aralık 2021, Haziran 2023). Hangisinin "yanlış" olduğuna karar verecek etiketli bir olay listesi yok. Sakin dönemlerde (2024–2026) neredeyse hiç işaret yok, ama bu bir ölçü değil gözlemdir.
- 5 olay çok küçük bir örnek; güven aralığı geniştir. Bu sonuç modeli KALİBRE etmez; modeller UNCALIBRATED/DEVELOPMENT kalır.
- Fon tarafı (TEFAS 2018–2025) hâlâ yok; bu test yalnız kur tarafıdır.
