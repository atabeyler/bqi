# M21 yaygınlık (breadth) alarmı — gerçek TEFAS haftalık akışları

2026-10-02 · 883 fon · referans = ilk 30 hafta (her fonun kendi normali + alarm seviyesi), değerlendirme = sonraki 9 hafta (zaman dışı).

Alarm = aynı haftada fonların hangi payı **kendi normalinin** 3 MAD altında çıkış yaptı. Referans dönemde bu payın ortalaması %4.4, std %1.1; alarm seviyesi **%9.4**.

## Gerçek değerlendirme haftaları

| Hafta sonu | Yaygınlık | Alarm | Fon büyüklüğü ağırlıklı net akış |
|---|---|---|---|
| 2026-07-17 | 3.5% |  | 1.5% |
| 2026-07-24 | 4.4% |  | 1.4% |
| 2026-07-31 | 5.1% |  | 0.3% |
| 2026-08-14 | 4.3% |  | 1.9% |
| 2026-08-21 | 5.5% |  | 0.9% |
| 2026-08-28 | 4.2% |  | 1.0% |
| 2026-09-11 | 7.5% |  | -0.9% |
| 2026-09-18 | 11.8% | **EVET** | -1.1% |
| 2026-09-25 | 21.0% | **EVET** | -1.4% |

## Eklenen sistem olayları (sakin gerçek haftalarda, rastgele fon payına −%10 çıkış)

| Etkilenen fon payı | Fon sayısı | Haftayı yakalama (breadth) | Tek tek fon yakalama (fon z-skoru) |
|---|---|---|---|
| 2.0% | 18 | 0.0% | 65.1% |
| 5.0% | 44 | 17.3% | 67.4% |
| 10.0% | 88 | 98.0% | 66.5% |
| 20.0% | 177 | 100.0% | 67.2% |

Sakin hafta sayısı: 7; deneme sayısı her pay için 150. Gerçek haftalardaki alarmlar nedeni hakkında bir şey söylemez, yalnızca yaygın eşzamanlı çıkışı gösterir.
