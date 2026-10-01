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
