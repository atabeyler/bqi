# SFRE v1.0.0 — Teknik Rapor (dürüst durum)

Tarih: 2026-10-01 · Branch: `ccr-22b87526-1193gy` · Repo: atabeyler/bqi

## 1. Sonuç özeti

* SFRE, mevcut BQI sunucusuna (Node/Express) **ikinci bir sistem kurmadan** eklendi: `server/src/sfre/`, `/api/sfre`, `client/src/pages/SfrePage.jsx`.
* 16 motor + PIT veri katmanı + evidence ledger + model governance + AI firewall + validation lab yazıldı; 183 yeni test geçiyor.
* **Hiçbir model CALIBRATED değil. Hiçbir model üretime onaylı değil. Gerçek veri yüklü değil.** Validation sentetik veri üzerindedir; makine ve iç tutarlılığı doğrular, gerçek dünya öngörü gücünü **kanıtlamaz**.
* TR-FUND-2026-001: yalnızca şartname. Gerçek veri yok → sonuç `BLOCKED_NO_DATA` (geçti **değil**).
* **Production readiness: HAYIR.** Blocker'lar §10.

## 2. Forensic audit (kod tabanı)

| Alan | Bulgu |
|---|---|
| Yapı | Node 22 ESM Express API (`server/`), React client, Electron/Android sarmalayıcılar, **BCI** (`bci/`, ayrı siber ürün: kendi DB/migration/RBAC/adaptörleri), Python/Qiskit worker (`server/quantum`). |
| Finans motoru | **Yoktu.** Graph/digital-twin yalnızca BCI güvenlik grafiğinde (`securityGraph.js`), finansla ilgisiz. Kuantum motorları: senaryo olasılığı, fraud kernel, portföy QAOA. |
| Yeniden kullanılan olgun parçalar | `lib/rbac.js` + `authMiddleware`; `benchmarkMetrics.js` (PR-AUC/konfüzyon, SFRE metriklerinde kullanılıyor); `dataEgressPolicy` kuralı (CONFIDENTIAL/RESTRICTED sorgu çıkışı yok); `webResearch.js` (artık tek bir düşük-güven sağlayıcı); `rateLimit`; vitest/CI; kuantum reproducibility hash fikri. |
| Zayıflıklar (mevcut) | `assessDataQuality` (DQ-1.0) ağırlıkları elle seçilmiş (0.3/0.15/0.25/0.3); `evidence.js` zaman damgası "şimdi", zincir/tamper-evidence yok; `fuseDecision` sayısal füzyon değil; araştırma tek kaynaklı DuckDuckGo HTML scraping; BCI `audit_events` yalnızca "konvansiyonla" append-only (DB tetikleyicisi yok); `sync.e2e.test.js` kök bağımlılık (`better-sqlite3`) yokken koşmuyor (ortam, SFRE'den bağımsız). |
| Baseline | server: 588 test geçti + 1 dosya ortam nedeniyle yüklenemedi; typecheck temiz; lint 0 hata. |

## 3. Mimari kararı

TypeScript/Node ana gövde; **sayısal motorlar saf ESM JS** (yeni bağımlılık yok, deterministik, seed'li xoshiro128**). Python bu ortamda numpy/scipy/sklearn olmadığı ve tek runtime evidence/hash/AI firewall'u senkron tuttuğu için sayısal çekirdek değil; **bağımsız stdlib-only Python referansı** (`server/sfre/crosscheck/reference.py`) test içinde çapraz doğrulama yapar. Çok büyük optimizasyon (>10⁴ fon) için SciPy hâlâ hedef (sınırlama).

## 4. Eklenen motorlar (hepsi UNCALIBRATED veya ESTIMATED)

M01 Microstructure · M02 Concentration (HHI, free-float) · M03 Overlap (+likidite-ağırlıklı) · M04 Liquidity (DTL) · M05 Flow/Redemption (β tahmini) · M06 Leverage · M07 Market Impact (Amihud-lineer, √-yasa; Y varsayılanı yok) · M08 Network · M09/10 Contagion & Fire-Sale Cascade (iteratif, iki yönlü uzlaşan kayıp ayrıştırması) · M11 Monte Carlo/Tail (ES, LAL, bileşen-ES) · M12 Regime (HMM, yalnız filtered) · M13 Reverse Stress (heuristik, global-optimum iddiası yok) · M14 Digital Twin · M15 Counterfactual · M16 Uncertainty · M20 Anomaly ensemble (6 detektör, disagreement raporlanır) · M30–M33 Fundamental/Valuation/Divergence/Accounting-quality (Beneish 8) · M40/M41 Disclosure + Claim-vs-Reality (6 sonuç) · M50 Pump-dump pattern similarity · M51 Attention/PROMOTION_MARKET_DIVERGENCE · M52 Coordinated activity · Research providers · Retail risk table (14 satır, skor/öneri yok).

## 5. Değişen / eklenen dosyalar

Değişen: `.github/workflows/ci.yml`, `client/src/App.jsx`, `client/src/services/api.js`, `server/package.json`, `server/src/index.js`.
Eklenen: `docs/sfre/*` (4 şartname + bu rapor + `results/`), `server/src/sfre/**` (core, data, engines, research, evidence, governance, ai, alerts, validation, storage, pipeline, tests), `server/src/routes/sfre.js`, `server/scripts/sfre-validate.js`, `server/scripts/sfre-benchmark.js`, `server/sfre/crosscheck/reference.py`, `client/src/pages/SfrePage.jsx`.

## 6. Gerçek test sonuçları (bu oturumda çalıştırıldı)

* `server`: **771 test geçti** (588 baseline + 183 SFRE), 1 dosya başarısız = `sync.e2e.test.js` (kök `better-sqlite3` yok; baseline'da da aynı, SFRE ile ilgisiz).
* `client`: 655 test geçti. `server` typecheck temiz; lint 0 hata (2 eski uyarı); `client` lint temiz; `check-i18n`, `check-version-consistency`, `check-locales` OK.
* SFRE testleri: unit, property/invariant (rastgele sistemlerde kayıp uzlaşması, monotonluk, HHI sınırları, overlap simetrisi), numerik regresyon, **bağımsız Python çapraz kontrol** (HHI, overlap, Amihud, robust-z, ES, Beneish, cascade kapalı form), synthetic known-answer, failure injection, historical replay (golden harness), performans, güvenlik (bütçe/ReDoS/RBAC).
* Zorunlu invariantlar test edildi: gelecek veri sızamaz (as-of + restatement regresyonu + feature-extractor kesilmiş-store eşitliği); overlap yoksa 0; eksik kaldıraç ≠ 0; aynı snapshot/model/seed → aynı sonuç; toplam kontagion kaybı bileşenleriyle reconcile (≤1e-9).
* Testlerin yakaladığı gerçek hatalar (hepsi düzeltildi, regresyon testi var): sabit seriyle OLS "dejenere" olmaması; ES kuyruk sayısında kayan-nokta (`(1−0.975)·200=5.000000000000004`→6 nokta); IF/LOF'un sabit eşiklerle ~%30 yanlış alarm vermesi (→ split-conformal eşik); sentetik dünya üretecinde sonsuz döngü; cascade'de sıfır-borç/sıfır-varlık fonun "iflas" sayılması; marj satışı fazlasının nakde dönmemesi; cascade O(n²·string) darboğazı (7.7 s → 0.48 s).

## 7. Validation sonuçları — SENTETİK (4 yeni seed: 2–5)

Tasarım: 330 fon (300 sağlıklı, 30 olay fonu; ~30 "kalıcı kırılgan ama sağlıklı" zor negatif), 40 varlık, 700 gün, 10 kriz, aylık+7g gecikmeli holdings, haftalık değerlendirme, 6 fold walk-forward (purge), %20 kilitli holdout, ufuk 45 gün. Karşılaştırılan kurallar: **A** (kırılganlık seviyesi, şampiyon) ve **B** (28g kırılganlık değişimi ∧ akış anomalisi, challenger).

| | A (şampiyon) | B (challenger) |
|---|---|---|
| PR-AUC (taban oran 0.0095) | 0.011–0.016 (≈ şans) | 0.049–0.241 |
| Precision | 0.012–0.015 | 0.103–0.186 |
| Recall (örnek bazlı) | 0.42–0.58 | 0.26–0.32 |
| FPR (örnek bazlı) | **0.32–0.40** | 0.014–0.022 |
| Olay yakalama (fon-olay, 21'de) | 15–19 | 15–20 |
| Lead time (medyan) | 21 gün | 10–14 gün |
| Sağlıklı fon başına ≥1 yanlış alarm (300 fon) | **%100** | **%22–31** |
| Alarm kararsızlığı (flip oranı) | 0.04–0.07 | 0.014–0.026 |
| Brier / ECE | 0.009–0.018 / 0.005–0.018 | 0.0098–0.0123 / 0.004–0.006 |

* **Hedef bütçe (fon başına yanlış alarm ≤ %5) hiçbir kural tarafından karşılanmadı.** B, A'dan çok daha iyi ama sağlıklı fonların %22–31'ine en az bir kez yanlış alarm veriyor: bu, "yüzlerce sağlıklı fonu yanlış alarm vererek olayı yakalamak da başarısızlıktır" ölçütüne göre **başarısız**.
* Negatif kontrol (etiket permütasyonu): **B 4/4 seed'de geçti** (p≈0.005); **A 3/4 seed'de geçemedi** (p=0.065–0.29). Zaman-karıştırma kontrolünde B'nin PR-AUC'si 0.014–0.043'e çöküyor (zamansal öncü yapıya dayanıyor).
* Ablation: akış koşulu çıkarılınca FPR +%31–51 puan (akış sinyali kritik); kırılganlık-değişimi koşulu çıkarılınca recall ~değişmiyor, precision düşüyor.
* Kilitli holdout (tek kez değerlendirildi; ikinci değerlendirme reddedildi): B PR-AUC 0.36–0.49 (tp 14–19, fn 14–19, fp 12–69); A 0.011–0.017.
* Champion/challenger (advisory): 4/4 seed'de B > A. Terfi yalnızca governance'tan.
* Regime robustness: HMM 3/4 seed'de tüm örnekleri tek rejimde işaretledi → **bilgi vermiyor**; 1 seed'de iki rejim (yüksek-vol'de recall 0). Rejim sağlamlığı kanıtlanmadı.
* Tasarım ifşası: ilk tanı seed 1'de yapıldı (akış detektörü referansı 26<30 hatası; stres %10→%3, referans 26→40 hafta). **Seed 1 yanık sayıldı; rapor yalnızca seed 2–5.** Seed 2–5 sonuçlarına göre eşik/kural ayarı yapılmadı. Aynı kod, aynı seed → aynı `result_hash` (seed 3–5 optimizasyon refaktöründen önce ve sonra bit-bit aynı).
* **Bu sonuçlar sentetik ve aynı yazar tarafından üretilen dünya üzerindedir. "BQI krizi öngörüyor" anlamına GELMEZ.**

## 8. Golden case sonuçları

* **TR-FUND-2026-001:** `server/src/sfre/validation/goldenCases/TR-FUND-2026-001.json`. Blind şartname: sonuç-türevli parametre yasak (validator reddediyor), `blind:true`, değerlendirme penceresi, öncü veri kapsama koşulları, sağlıklı kontrol kuralı (≥100), FPR bütçesi %5. Olay olguları **yalnızca basın haberleri** (Euronews 17.09.2026, Medyascope 22.09.2026): bildirilen 28 Ağustos 2026 SPK kuralı (büyük pozisyonlar toplamı limiti) ve 17 Eylül 2026'da 7 portföy şirketinin 131 fonunun tasfiyesi kararı. **SPK birincil belgesiyle doğrulanmadı**, `event_time=null`, varlık listesi boş. **Sonuç: `BLOCKED_NO_DATA`** — gerçek PIT holdings/free-float/ADV verisi yok. Düzenleyici tetikleyicinin kendisi gözlemlenemez öncü olarak işaretli (SFRE kırılganlığı ölçer, düzenlemeyi tahmin etmez).
* Replay harness'ı sentetik dünyada test edildi: `RELEASE_FAILURE` (yeterli veri + alarm yok), `FALSE_ALARM_BUDGET_EXCEEDED` (herkese alarm), `BLOCKED_NO_DATA` (kapsam/kontrol yetersiz), ve sentetik veri **asla `PASSED` üretmez** (`SYNTHETIC_HARNESS_PASS`).
* **Market-integrity golden cases:** kayıt defteri **boş** (SPK-doğrulanmış, PIT'e yeniden kurulabilir vaka bulunamadı; fiyat/hacim lisanslı veri yok). Harness boş kayıtta sonuç vermeyi reddediyor. "BQI olay bilinmeden alarm verebilir miydi?" sorusu **cevaplanmadı**.

## 9. Kalibrasyon durumu, lead time, false-positive özeti

* CALIBRATED: **yok**. ESTIMATED (örneklem-içi, CI'lı): M01 (α/β), M05 (β), M07 Amihud-lineer, M12 HMM. Diğerleri UNCALIBRATED (sabitler konvansiyon; `MATHEMATICAL_SPECIFICATION.md` parametre kaydı).
* Gerçek veride **ölçülmüş** FPR / lead time: **yok**. Sentetik lead time ve FPR yukarıda (§7).
* Governance: tüm modeller `DEVELOPMENT`. SYNTHETIC-only validation `SHADOW`'a geçiremez; `APPROVED` ayrı bir insan onaylayıcı ister; `ALARMING` kullanımı ≥30 gerçek pozitif olay + negatif kontrol + tek-kullanımlık holdout ister.

## 10. Eksik gerçek veri ve production blocker'lar

Eksik gerçek veri: fon holdings/akışları (TEFAS/KAP/SPK), kaldıraç/repo/türev ve karşı-taraf maruziyeti (genelde kamuya açık değil → UNOBSERVED), BIST OHLCV + free float (lisans), KAP arşivi (doğrulanmış endpoint yok), finansal tablolar (filing-time), SPK bültenleri/işlem yasakları, attention serileri.

Blocker'lar:
1. Gerçek PIT veri hattı ve lisanslar yok → hiçbir model gerçek veride doğrulanmadı.
2. KAP/SPK/BIST/IR sağlayıcıları yalnızca kabuk (`UNAVAILABLE`); yapılandırılmış doğrulanmış gateway gerekli. HTML scraping bilerek yapılmadı.
3. Kalıcılık: PostgreSQL şeması (`storage/schema.sql`, append-only tetikleyicili) yazıldı ama **hiç çalıştırılmadı/test edilmedi** (bu ortamda PG sunucusu yok). Çalışan route'lar süreç-içi bellek kullanır (yeniden başlatmada kayıp).
4. Motorlar API iş parçacığında **senkron** çalışır; istek bütçeleri ile sınırlı ama worker/kuyruk (mevcut `quantumJobQueue` modeli) gerekli. Tail 100k senaryo ≈ 11 sn.
5. Sentetik validation'da FPR bütçesi sağlanmadı; gerçek veride ≥30 olay + yüzlerce sağlıklı fon gerekir.
6. Model governance için gerçek onay iş akışı/kimlik doğrulama entegrasyonu (şu an admin JWT = human actor varsayımı).
7. Regime motoru bu sentetik veride bilgi vermiyor.
8. Claim extraction kural-tabanlı ve ölçülmemiş; her claim `requiresHumanReview`.

## 11. Güvenlik bulguları

SFRE'de giderilenler: istek boyut/bütçe sınırları (fon, varlık, tail N, reverse-stress bütçesi, seri, metin); disclosure regex girdi sınırı (ReDoS testi); `/runs` ve `/narrative` rate-limit; RBAC (viewer koşturamaz, analist model geçişi yapamaz); **koşu/claim/narrative yalnızca sahibi+admin** (diğerleri 404, kimlik probe'u yok; testli); governance'ta aktör body'den değil JWT'den; kişi-profilleme alanları (`email`, `tckn`, `handle`…) reddedilir; author anahtarları tuzlu hash; DDG sorguları CONFIDENTIAL/RESTRICTED için engelli; AI çıktısı doğrulanır (sayı/durum/tavsiye/suçlama/kesinlik).
Açık: bellek-içi store yeniden başlatmada kayıp; ledger süreç-içi (çoklu örnekte paylaşılmaz); senkron CPU (DoS yüzeyi bütçeyle azaltıldı, kaldırılmadı); mevcut repo bulguları §2.

## 12. Benchmark (bu makinede, tek iş parçacığı)

Cascade: 50 fon×100 varlık 125 ms; 200×300 276 ms; **1000×1000 1.4 sn**. Tail (2 yöntem): 10k senaryo×50 varlık×20 fon 0.71 sn; 100k 11.4 sn. Anomali ensemble (6 detektör, 500 ref) 74 ms. Reverse stress (20×20, varsayılan bütçe) 1.3 sn. PitStore.asOf (134k gözlem) 0.29 sn; 134k gözlemin hash'li alımı 3.7 sn. Ayrıntı: `docs/sfre/results/benchmark.json`.

## 13. Bilinen sınırlamalar

Cascade yapısı Greenwood–Landier–Thesmar/Cont–Schaanning ailesinden, Türkiye'ye fit edilmedi; satışlar önceki işaretten yürütülür (satıcı kayması kalan pozisyon üzerinden); kayıp atfı lineer muhasebe kuralıdır (nedensel iddia değil); counterfactual'lar model-içi (nedensel tanımlama değil); reverse stress yerel/heuristik, alt sınır yok; Beneish katsayıları ABD örneği (BIST için UNCALIBRATED); anomali eşikleri konvansiyon/conformal (α hedef, ölçülmüş oran değil); IF/LOF kalibrasyon seti küçükse eşik çözünürlüğü sınırlı (`thresholdResolvable`); sentetik dünya yazarla aynı kişiden — optimistik.

## 14. Production readiness

**Hazır değil.** Kod yapısı, evidence zinciri, governance ve testler üretim disiplininde; ama (i) gerçek veri/kalibrasyon yok, (ii) kalıcılık katmanı testsiz, (iii) senkron yürütme, (iv) FPR bütçesi sentetikte bile tutmuyor. Mevcut hâliyle yalnızca **NON_PRODUCTION senaryo/ölçüm aracı** olarak kullanılmalı; hiçbir çıktı yatırım tavsiyesi veya suç isnadı olarak sunulamaz.
