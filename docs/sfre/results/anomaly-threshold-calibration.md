# M20 eşik kalibrasyonu (gerçek TEFAS haftalık akışları)

2026-10-02 · 150 eğitim / 150 test fonu (ayrık) · 293 eğitim, 290 test penceresi · hedef yanlış alarm (her dedektör) = %5.

Eşik = eğitim fonlarının dokunulmamış gerçek pencerelerindeki dedektör skorunun (1-α) yüzdeliği. Sonuçlar **hiç görülmemiş test fonlarında** ölçüldü. Zaman bazlı ayrım mümkün değil (30 haftalık referans verinin çoğunu tüketiyor). Modelleri veya durumlarını değiştirmez.

## Eşikler

| Dedektör | Varsayılan (ders kitabı) | Kalibre |
|---|---|---|
| robust-z | 3.50 | 11.61 |
| EWMA | 1.00 | 2.44 |
| CUSUM | 5.00 | 12.92 |

## Test fonlarında yanlış alarm (dokunulmamış pencereler)

| Kural | Varsayılan | Kalibre |
|---|---|---|
| robust-z | 29.3% | 4.8% |
| EWMA | 23.1% | 6.2% |
| CUSUM | 21.0% | 5.9% |
| Çoğunluk (≥2/4) | 25.5% | 6.2% |
| Herhangi biri | 40.0% | 31.4% |

## Test fonlarında yakalama (son hafta bilinen büyüklükte çıkışla değiştirilmiş, çoğunluk kuralı)

| Haftalık çıkış | Varsayılan | Kalibre |
|---|---|---|
| %10 | 68.6% | 25.9% |
| %20 | 86.2% | 47.2% |
| %30 | 94.1% | 64.8% |

## Oynaklığa göre (test fonları, çoğunluk kuralı)

| Oynaklık | Yanlış alarm (varsayılan → kalibre) | %10 | %20 | %30 |
|---|---|---|---|---|
| low | 18.6% → 3.1% | 99.0% → 54.6% | 100.0% → 87.6% | 100.0% → 99.0% |
| mid | 25.5% → 6.1% | 66.3% → 13.3% | 93.9% → 37.8% | 100.0% → 67.3% |
| high | 32.6% → 9.5% | 40.0% → 9.5% | 64.2% → 15.8% | 82.1% → 27.4% |
