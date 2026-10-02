# Para piyasası fonu akışı: açık veri doğrulaması (FRED, haftalık)

Veri: ABD para piyasası fonları toplam varlıkları (kamuya açık). Parametreler çalıştırmadan önce yazıldı: pencere 104 hafta, ısınma 52, ≥5 robust sigma, ≥%1 haftalık hareket, tolerans ±7 gün. Çalıştırma: 2026-10-02.

**Yakalama: 2/5**

| # | Olay | Seri | t0 | Yakalandı | İşaret | Hareket |
|---|---|---|---|---|---|---|
| M1 | Reserve Primary Fund "broke the buck" (Lehman sonrası) | WIMFNS (kurumsal) | 2008-09-16 | evet | 2008-09-22 | -5.1% |
| M2 | Mart 2020 prime fon kaçışı (Fed MMLF açıldı) | WIMFNS (kurumsal) | 2020-03-18 | evet | 2020-03-16 | 3.8% |
| – | olay dışı işaret (1990+) | WIMFNS | 1980-02-04 → 2021-02-01 | 13 | 0.42/yıl | 1991-01-14, 1992-01-06, 1992-01-13, 1992-02-24, 1992-03-02, 1992-07-13, 1992-10-05, 1996-02-12, 2001-09-24, 2016-01-11, 2018-12-17, 2020-03-30, 2020-04-06 |
| M1 | Reserve Primary Fund "broke the buck" (Lehman sonrası) | WRMFNS (bireysel) | 2008-09-16 | **hayır** | – | – |
| M2 | Mart 2020 prime fon kaçışı (Fed MMLF açıldı) | WRMFNS (bireysel) | 2020-03-18 | **hayır** | – | – |
| M3 | SVB çöküşü sonrası para piyasası fonlarına akın | WRMFNS (bireysel) | 2023-03-13 | **hayır** | – | – |
| – | olay dışı işaret (1990+) | WRMFNS | 1980-02-04 → 2026-08-31 | 4 | 0.11/yıl | 2007-08-27, 2015-12-21, 2016-01-11, 2023-01-09 |

Yorum: kurumsal seride 2/2, bireysel seride 0/3. Bireysel fonların bu olaylarda gerçek bir çıkış yaşamadığını sonradan söylemek kolay ama bu açıklamayı veriyle sınamadım; sonuç olduğu gibi yayımlanır. 1990'lardaki işaretler veri kaynağındaki aralıklı güncelleme yüzünden sahte olabilir.

## Sınırlar
- Bu bir **toplam** seridir, fon kesiti değildir; breadth motoru (M21) burada çalışamaz, yani Türkiye'deki asıl iddia test edilmedi.
- Toplam varlıktaki hareket yönsüzdür: 2008'de kurumsal fonlara giriş (devlet fonlarına kaçış) çıkış gibi aynı işaretle görünür.
- 3 olay çok küçük örnek. Kurumsal seri 2021'de bitiyor, SVB (2023) yalnız bireysel seride var.
