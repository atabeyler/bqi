# BFI akış kalibrasyonu (TEFAS tarihsel, 2026-10-02)

Kaynak: `tefas:tarihsel` (PostgreSQL). En az 10.000.000 TL fon büyüklüğü ve 100 yatırımcı. Tarihsel dağılımı ölçer; tahmin değildir.

## Veri kalitesi

| Kontrol | Sayı |
|---|---|
| fundWeeks | 397.772 |
| flowAbsGt1 | 2.889 |
| flowAbsGt5 | 885 |
| navNonPositive | 0 |
| navDayJumpGt50 | 89 |
| aumNonPositive | 554 |
| fundsNoName | 0 |

## Haftalık net akış (fon büyüklüğüne oran)

| Grup | Fon | Fon-hafta | p0.1 | p1 | p5 | medyan | p95 | p99 | >%10 çıkış sıklığı | büyüklük-ağırlıklı p1 | büyüklük-ağırlıklı p5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TÜMÜ | 1182 | 211202 | -71.63% | -31.28% | -11.09% | -0.27% | 13.85% | 53.75% | 5.65% | -38.91% | -10.59% |
| altin_kiymetli | 73 | 12459 | -49.27% | -19.41% | -5.55% | -0.23% | 12.69% | 42.20% | 2.40% | -5.82% | -2.77% |
| borclanma | 78 | 15409 | -66.06% | -28.94% | -12.95% | -0.38% | 12.72% | 47.49% | 7.34% | -21.14% | -10.32% |
| degisken_karma | 239 | 43194 | -54.74% | -20.93% | -7.79% | -0.38% | 10.09% | 36.89% | 3.43% | -24.21% | -6.68% |
| diger | 62 | 11289 | -62.83% | -23.34% | -9.31% | -0.10% | 15.71% | 58.72% | 4.42% | -18.35% | -7.24% |
| hisse | 278 | 48977 | -73.07% | -31.06% | -11.93% | -0.56% | 11.83% | 48.40% | 6.16% | -36.11% | -12.49% |
| para_piyasasi | 144 | 25146 | -83.08% | -52.93% | -24.40% | -0.14% | 31.41% | 102.13% | 13.26% | -48.96% | -20.37% |
| serbest | 308 | 54728 | -71.45% | -24.25% | -8.19% | -0.02% | 10.17% | 43.17% | 3.97% | -13.80% | -4.87% |

## Getiri → akış duyarlılığı (önceki hafta getirisi, eğim ± std. hata)

| Grup | Getiri < 0 eğimi | t | Getiri ≥ 0 eğimi | t |
|---|---|---|---|---|
| altin_kiymetli | 0.010 | 0.3 | 0.535 | 14.7 |
| borclanma | 0.673 | 2.2 | 1.533 | 10.0 |
| degisken_karma | 0.268 | 7.4 | 0.877 | 29.7 |
| diger | 0.285 | 2.4 | 1.235 | 14.5 |
| hisse | 0.266 | 12.3 | 0.674 | 25.9 |
| para_piyasasi | — | — | 18.738 | 12.7 |
| serbest | 0.161 | 5.0 | 0.528 | 18.1 |

## Örneklem dışı doğrulama (eğitim < 2026-04-01 ≤ test)

Beklenen aşım ile gözlenen aşım yakınsa dağılım kararlıdır.

| Grup | Eğitim | Test | p1 altı (bekl. 1%) | p5 altı (bekl. 5%) | p95 üstü (bekl. 5%) | p99 üstü (bekl. 1%) |
|---|---|---|---|---|---|---|
| all | 112785 | 98417 | 1.64% | 5.94% | 4.29% | 0.95% |
| altin_kiymetli | 6415 | 6044 | 0.48% | 4.83% | 1.08% | 0.46% |
| borclanma | 8405 | 7004 | 1.28% | 4.30% | 6.15% | 0.97% |
| degisken_karma | 22884 | 20310 | 1.61% | 6.77% | 3.41% | 0.77% |
| diger | 5855 | 5434 | 0.74% | 5.04% | 5.43% | 1.36% |
| hisse | 26323 | 22654 | 1.54% | 5.87% | 4.26% | 0.67% |
| para_piyasasi | 13091 | 12055 | 2.31% | 7.50% | 4.69% | 1.21% |
| serbest | 29812 | 24916 | 1.61% | 5.88% | 4.70% | 1.04% |

## Önerilen haftalık çıkış oranları (senaryo varsayılanları)

| Grup | Hafif (p5) | Şiddetli (p1) | Aşırı (p0.1) |
|---|---|---|---|
| altin_kiymetli | 5.55% | 19.41% | 49.27% |
| borclanma | 12.95% | 28.94% | 66.06% |
| degisken_karma | 7.79% | 20.93% | 54.74% |
| diger | 9.31% | 23.34% | 62.83% |
| hisse | 11.93% | 31.06% | 73.07% |
| para_piyasasi | 24.40% | 52.93% | 83.08% |
| serbest | 8.19% | 24.25% | 71.45% |
