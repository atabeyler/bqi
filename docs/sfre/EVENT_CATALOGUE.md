# Olay kataloğu (Faz 2: gerçek olay testi)

Amaç: BFI motorlarının gerçek stres olaylarında ne zaman ve ne dediğini önceden yazılmış protokolle ölçmek. Tarihler **2 Ekim 2026'da web kaynaklarıyla teyit edildi** (aşağıdaki bağlantılar); proje sahibi son onayı verir. Teyit edilemeyen hiçbir şey teste girmez.

## Kural (sonuca bakmadan sabit)

1. Her olay için tek bir **başlangıç tarihi** (`t0`) ve kaynağı yazılır.
2. Motor, `t0`'dan **önceki** veriyle kalibre edilir. `t0` sonrası veri kalibrasyona giremez.
3. Ölçütler: ilk sistem seviyesi alarmın tarihi (erken uyarı süresi = `t0` − alarm; negatif = alarm geç geldi), olay dışı dönemlerde yanlış alarm sayısı/yıl, alarmın kapsadığı fon payı.
4. Sonuçlar olumsuz olsa da yayımlanır.

## Teyit edilmiş olaylar

| # | Olay | t0 | Ne oldu (kaynaklara göre) | Kaynak |
|---|---|---|---|---|
| E1 | Ağustos 2018 kur şoku | **2018-08-10** | ABD'nin çelik/alüminyum gümrük vergisini ikiye katlaması; TL bir günde ~%14 değer kaybetti (gün içinde ~%20), rekor düşük | [CNBC](https://www.cnbc.com/2018/08/10/turkish-lira-loss-deepens-as-pm-erdogan-calls-for-citizens-to-convert-.html), [France 24](https://www.france24.com/en/20180810-turkey-curency-lira-plunge-erdogan-trump-twitter-tariffs) |
| E2 | Covid / petrol çöküşü ("Kara Pazartesi") | **2020-03-09** | Küresel çöküş: petrol tek günde %20+ düştü, Dow ~%6 düştü. **Borsa İstanbul'a özgü etki bu aramada teyit edilemedi**, ayrıca kontrol edilmeli | [Wikipedia: 2020 stock market crash](https://en.wikipedia.org/wiki/2020_stock_market_crash) |
| E3 | Merkez Bankası Başkanı Ağbal'ın görevden alınması | **2021-03-22** (karar 20 Mart Cumartesi) | TL 22 Mart'ta ~%15 düştü, Borsa İstanbul iki kez devre kesici, ~%8 düşüş | [Al Jazeera](https://www.aljazeera.com/economy/2021/3/22/turkish-lira-plunges-after-erdogan-sacks-central-bank-chief), [CNN](https://www.cnn.com/2021/03/22/economy/turkey-lira-erdogan-central-bank-intl-hnk/index.html) |
| E4 | Aralık 2021 kur şoku | **2021-12-16** (faiz indirimi; zirve 20 Aralık) | Politika faizi %15 → %14, TL rekor düşük (15,5); 20 Aralık'ta 18,36; aynı gece kur korumalı mevduat açıklandı, TL sert toparlandı; Borsa 17 ve 20 Aralık'ta durdu | [CNBC](https://www.cnbc.com/2021/12/16/turkish-central-bank-cuts-rates-sending-lira-to-record-low.html), [Al Jazeera](https://www.aljazeera.com/economy/2021/12/21/turkish-lira-rebounds-after-erdogans-anti-dollarization-plan) |
| E5 | Şubat 2023 depremleri | **2023-02-06** | Borsa İstanbul 8 Şubat'ta devre kesici sonrası kapatıldı (24 yıl sonra ilk), 15 Şubat'ta açıldı | [Bloomberg](https://www.bloomberg.com/news/articles/2023-02-08/turkey-halts-stock-market-trading-until-february-15-after-rout), [CNN](https://www.cnn.com/2023/02/15/business/turkey-market-reopens/index.html) |
| E6 | 14 Mayıs 2023 seçimi | **2023-05-15** (ilk piyasa günü) | BIST 100 %6,1 düştü (bankacılık endeksi %9,2), devre kesici, TL rekor düşük (19,67) | [CNBC](https://www.cnbc.com/2023/05/15/turkey-elections-lira-and-stocks-slide-as-president-erdogan-gains-momentum.html), [CNN](https://www.cnn.com/2023/05/15/investing/turkey-election-lira-markets-fall) |
| E7 | İmamoğlu'nun gözaltı dalgası | **2025-03-19** | TL gün içinde ~%12,7 düştü (rekor ~42/USD), Borsa İstanbul iki kez durdu (~%6,87 düşüş) | [Balkan Insight](https://balkaninsight.com/2025/03/19/turkish-economy-takes-hit-after-istanbul-mayors-detention/bi/), [Cyprus Mail](https://cyprus-mail.com/2025/03/19/turkeys-lira-plunges-to-record-low-after-erdogan-rivals-detention) |
| **E8** | **Eylül 2026 fon krizi** (TEFAS verimizde var) | **2026-09-17** | SPK 130 fonun tasfiyesini emretti, 7 şirketin fonlarında alım/satım durduruldu; fonlar ağustos sonundan 18 Eylül'e ~510 milyar TL varlık kaybetti (net çıkış ~411 milyar TL); BIST 100 ~%6 düştü; para piyasası fonlarından 11 Eylül haftasında 1,8 milyar $ çıkış | [Turkish Minute (17 Eyl)](https://www.turkishminute.com/2026/09/17/turkey-orders-liquidation-of-130-investment-funds-after-market-selloff/), [Turkish Minute (18 Eyl)](https://www.turkishminute.com/2026/09/18/turkey-begins-18-3-billion-liquidation-after-fund-run/), [Bloomberg](https://www.bloomberg.com/news/articles/2026-09-22/turkish-fund-exodus-flowing-into-lira-deposits-goldman-says) |

Not: kaynaklar haber/bilgi sitelerindendir; sayılar kaynakta yazıldığı gibi aktarılmıştır, bağımsız doğrulanmamıştır.

## İlk sonuç: E8 (elimizdeki tek olay)

BFI breadth alarmı (`breadth-trial-tefas.md`, referans ilk 30 hafta, zaman dışı test):

| Hafta sonu | Yaygınlık | Alarm | Not |
|---|---|---|---|
| 2026-09-04 | %6,0 | hayır | Çıkışlar yükselmeye başlıyor (taban %4,4) |
| 2026-09-11 | %7,0 | hayır | Alarm seviyesi (%10,4) altında; para piyasası fonlarından çıkış başlamıştı |
| **2026-09-18** | **%10,8** | **EVET** | **SPK'nın tasfiye emri 17 Eylül, yani alarm olayla aynı hafta** |
| 2026-09-25 | %20,9 | EVET | Kriz sürüyor |

Dürüst yorum: motor krizi **olayla eş zamanlı** işaretledi ve önceki iki haftada yükselişi gösterdi ama alarm seviyesini aşmadı; **bu olayda erken uyarı süresi ≈ 0 hafta**. Bu, tek bir olaya dayalı bir sonuçtur. Faz 2'nin amacı bunu E1–E7 ile (daha uzun TEFAS geçmişi gerekir) tekrarlamaktır. Alarm seviyesinin gevşetilmesi E8'de daha erken sinyal verirdi ama yanlış alarmı artırırdı (bkz. eşik eğrisi).

## Gerekli veri (olay başına)

| Veri | Kaynak | Durum |
|---|---|---|
| TEFAS fon akışı (E1–E7: 2018–2025) | TEFAS arayüzü (aylık 1 ay sınırı, hız sınırı var) | Yerelde Tem 2025 → Eyl 2026 (15 ay); E1–E7 için gerekli geçmiş yok |
| BIST günlük fiyat | Borsa İstanbul DataStore | Yok (lisans) |
| Kur, faiz, makro | TCMB EVDS (ücretsiz API anahtarı) | Yok (anahtar gerekli) |
| Fon portföyü | KAP / MKK API | Yok (başvuru) |

## Sen yapacaksın: kontrol listesi

- [x] Olay tarihlerinin kaynaklarla teyidi (yukarıda). **E2'de Borsa İstanbul etkisini ayrıca doğrula.**
- [ ] **TCMB EVDS:** evds2.tcmb.gov.tr → ücretsiz hesap → profil sayfasından **API anahtarı**. `server/.env` içine `TCMB_EVDS_KEY=` olarak yaz (sohbete yazma).
- [ ] **MKK API Portal:** apiportal.mkk.com.tr → Kayıt Ol → hesap onayı → uygulama oluştur → KAP Veri Yayın Servisi ürününe kaydol. Başvuru taslağı: `DATA_REQUESTS.md`.
- [ ] **Borsa İstanbul DataStore:** datastore.borsaistanbul.com → giriş → Pay Piyasası Verileri → günlük fiyat paketinin fiyat ve koşullarını ilet.
