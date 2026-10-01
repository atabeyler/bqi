# SFRE — Operasyon Kılavuzu (anahtarlar geldikten sonra)

## 0. Durum
Uygulama kodu hazır: PostgreSQL kalıcılığı (gerçek PG 16'da test edildi), worker-thread yürütme, TEFAS/BIST/holdings dosya içe aktarıcıları, KAP REST istemcisi, gerçek-veri replay'i, API, arayüz (`/sfre`). **Yapılandırma ve veri sizde.**

## 1. Yapılandırma (ortam değişkenleri; `.env.example`'da)
| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | evet (kalıcılık için) | Mevcut BQI Postgres'i; SFRE tabloları (`sfre_*`) otomatik oluşur, append-only tetikleyicilerle. |
| `SFRE_KAP_BASE_URL`, `SFRE_KAP_API_KEY` | KAP için | MKK onboarding belgelerinden. Kamuya açık PDF taban URL'yi ve auth başlığını **belirtmiyor**. |
| `SFRE_KAP_AUTH_HEADER`, `SFRE_KAP_AUTH_SCHEME` | hayır | Varsayılan `Authorization: Bearer <key>`. Ham anahtar başlığı için şema boş bırakılır. |
| `SFRE_OFFICIAL_*_FEED_URL/TOKEN` | hayır | SPK/BIST/IR/haber için lisanslı JSON gateway (şema `.env.example`'da). |

## 2. Veri yükleme
Arayüzden: `/sfre` → **Veri** sekmesi (yalnızca admin; .xlsx/.xls/.csv, 25 MB, içerik-uzantı doğrulaması). Aynı işlemi API ile: `POST /api/sfre/ingest/{tefas|bist-eod|free-float|holdings}` (multipart `file`, opsiyonel `lagDays`). Senaryo sekmesi yüklenmiş veriyle çalışır: `POST /api/sfre/runs/from-data` (`asOf`, `seed`, `engines`, `scenario`); veri eksik olan fonlar atlanır ve nedeniyle listelenir (eksik bilanço kalemi asla sıfır sayılmaz).

### CLI

```
npm run sfre:ingest -- tefas   TarihselVeriler.xlsx            # fon NAV, pay, kişi, AUM, varlık dağılımı -> haftalık net akış
npm run sfre:ingest -- bist-eod  gunsonu.csv                    # BIST günlük OHLCV (DataStore/dağıtıcı)
npm run sfre:ingest -- free-float fiili_dolasim.xlsx
npm run sfre:ingest -- holdings fon_hisse_portfoy.xlsx --lag-days 10   # fon, tarih, hisse kodu, ağırlık%
npm run sfre:ingest -- kap-probe --param key=value             # ilk canlı çağrı: ham yanıtı gösterir
npm run sfre:ingest -- kap-sync  --param key=value             # bildirimleri PIT gözlemi olarak yazar
```
Her satır doğrulanır (hash + PIT zamanları), tekrarlar yok sayılır, tanınmayan sayfa/sütunlar `skipped` olarak raporlanır, **boş hücre = UNOBSERVED (0 değil)**.

## 3. PIT gecikme varsayımları (ESTIMATED işaretli; gerçek yayın zamanıyla DEĞİŞTİRİN)
- TEFAS tarihsel: olay günü + `--lag-days` (varsayılan 1 gün).
- Holdings: rapor tarihi + `--lag-days` (varsayılan 10 gün; **kaynağın gerçek gecikmesini girin**).
- BIST EOD: aynı gün 18:30 TSİ. Free float: +1 gün.
- KAP bildirimleri: yayın zamanı API'den (`ESTIMATED` değil).

## 4. KAP istemcisi — doğrulanmamış varsayımlar
Kamuya açık MKK PDF'i yalnızca servis adlarını verir. İstemci: `Authorization: Bearer` (ayarlanabilir), `GET {base}/{servis}?{param}`; yanıtta dizi veya `.data/.items/.disclosures`. Alan adları toleranslı eşlenir ama **bildirim no ve yayın zamanı yoksa kayıt reddedilir** (tahmin yok). İlk gerçek çağrıda `kap-probe` çıktısına bakıp `ingest/kap.js` alan takma adlarını ayarlayın. Zaman dizesi saat dilimsiz ise İstanbul yerel saati (UTC+3) varsayılır.

## 5. Altın vaka (TR-FUND-2026-001)
1. TEFAS + holdings + BIST EOD + free float yükleyin (≥ 365 gün öncesi).
2. SPK birincil belgesinden `confirmed.json` yazın: `{"event_time":"…Z","event_entities":["FUND:XXX"],"source_url":"…","confirmed_by":"ad"}`.
3. `npm run sfre:replay -- confirmed.json`. Kapsam < %80 veya sağlıklı kontrol < 100 ise sonuç `BLOCKED_NO_DATA`; geçmek için hem erken alarm hem fon başına yanlış alarm ≤ %5 gerekir. Sonuç `sfre_records` (`golden_replays`) tablosuna yazılır.

## 6. Çalıştırma
`/api/sfre/*` mevcut sunucuyla birlikte açılır; `/sfre` sayfası admin/analist içindir. Ağır hesaplar worker thread'de (zaman aşımı 120 sn, eşzamanlı 2; aşımda 429/504). Sağlık: `GET /api/sfre/health` (depolama, ledger doğrulaması, sağlayıcı yapılandırma durumu).

## 7. Hâlâ sizden beklenenler
Anahtarlar/sözleşmeler (docs/sfre/DATA_REQUESTS.md), veri dosyaları, SPK onaylı olay bilgisi, model onay kararları (governance). Model onayı olmadan tüm çıktılar `NON_PRODUCTION`.


## Otomatik veri senkronu

Tek yerden tüm kurum kaynakları: `server/src/sfre/ingest/syncService.js`. Hepsi aynı doğrulanmış, hash ile tekilleştirilmiş yoldan geçer (tekrar çalıştırmak güvenlidir). `SFRE_SYNC_ENABLED=true` + `DATABASE_URL` ile sunucu açılışında zamanlayıcı başlar (`SFRE_SYNC_INTERVAL_MIN`, varsayılan 60 dk).

| Kaynak | Yol | Durum |
|---|---|---|
| KAP / MKK | REST API (`SFRE_KAP_BASE_URL`, `SFRE_KAP_API_KEY`, `SFRE_KAP_SYNC_PARAMS`) | MKK onboarding sonrası otomatik |
| Borsa İstanbul (BIST EOD), serbest dolaşım, fon-hisse portföy | Yetkili HTTP dosya beslemesi `SFRE_FEED_<KIND>_URL` (+ `_TOKEN`) | Lisans/erişim sonrası otomatik |
| TEFAS | **API yok** (TEFAS SSS: API paylaşımı yapılmıyor; Borsa İstanbul Pazarlama ve Satış'a başvuru). Arayüzden indirilen Excel `SFRE_INBOX_DIR` içine `tefas_*.xlsx` adıyla bırakılır, otomatik alınır | Yarı otomatik |

TEFAS notları: arayüz tek seferde en fazla 1 aylık aralık veriyor; hızlı art arda indirmelerde güvenlik duvarı "Request Rejected" verebilir (bypass edilmez, beklenir). Dosya içeriği hash'lenir: yeniden adlandırma/yeniden bırakma çift sayım yapmaz. İlk 4 satır "Rapor Bilgileri" bloğudur, importer otomatik atlar.

API: `GET /api/sfre/sync/status`, `POST /api/sfre/sync/run` (yalnız admin). Test: `SFRE_REAL_DATA=1 npx vitest run src/sfre/tests/syncService.test.js` gerçek TEFAS dosyalarını (`~/sfre-data/raw`) bellek içi store'a yükleyip doğrular.

### Kurum erişim durumu (1 Ekim 2026'da arayüzden doğrulandı)

- **TEFAS:** API paylaşılmıyor (resmi SSS). Arayüz tek seferde en fazla 1 ay veriyor; art arda indirmelerde güvenlik duvarı kısa süreli "Request Rejected" veriyor, bekleyince açılıyor. Excel üretimi tarayıcıda yapıldığı için indirme 20-60 sn sürer.
- **MKK API Portal (apiportal.mkk.com.tr):** KAP için "KAP Data Dissemination Services" (REST) ürünü var. Adımlar: portalda hesap aç (Sign in / Register) -> hesap onayı -> uygulama oluştur (API key üretir) -> ürüne kaydol -> gerekirse token üret. Test ağ geçidi \`https://apigwdev.mkk.com.tr/\`, istekte \`Authorization\` başlığı gerekir. Bu değerler \`SFRE_KAP_BASE_URL\` / \`SFRE_KAP_API_KEY\` olarak girilir; ilk çağrıda \`kap-probe\` ile alan adları doğrulanmalı. Hesap açma ve onay kullanıcıya aittir.
- **Borsa İstanbul DataStore:** Pay Piyasası, Endeks, Borçlanma, VİOP, Halka Arz, Kıymetli Maden kategorileri var; ürün/abonelik ve fiyat listesi giriş yapmadan görünmüyor ("abonelik mevcut değil"). Fiyat ve satın alma adımları için hesapla giriş gerekir; satın alma kullanıcıya aittir. Alınan veri \`SFRE_FEED_BIST_EOD_URL\` beslemesiyle ya da \`bist-eod_*.csv\` olarak inbox'a bırakılarak içeri alınır.
- **Doğrulama:** \`PGlite\` (bellek içi PostgreSQL) üzerinde gerçek \`PgStore\` + senkron servisiyle bir aylık gerçek TEFAS dosyası (213.836 gözlem) yüklendi; yeniden yükleme 0 yeni kayıt, PIT filtresi gelecekteki gözlemleri gizledi.
