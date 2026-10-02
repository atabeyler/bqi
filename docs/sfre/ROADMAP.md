# BFI yol haritası: prototipten kanıtlanmış ürüne

Hedef konum: **Türkiye'ye özel, şeffaf ve denetlenebilir sistemik risk / piyasa bütünlüğü izleme sistemi.** Küresel Aladdin/Bloomberg rakibi olmayı hedeflemiyoruz; "neden bu alarm?" sorusuna kanıt zinciriyle cevap veren, gerçek olaylarda ölçülmüş bir sistem olmayı hedefliyoruz.

Süreler tahmindir, veri erişimi ve lisans sürelerine bağlıdır. "Sen" = proje sahibi (hesap, lisans, başvuru, onay), "Ben/Claude" = geliştirme ve analiz.

## Bugünkü durum (2 Ekim 2026)

| Alan | Puan /10 | Kanıt |
|---|---|---|
| Mimari ve metodoloji disiplini | 8 | PIT veri, silinemeyen kanıt zinciri, "kalibre edilmemiş" etiketi, yeniden üretilebilirlik |
| Model kapsamı | 7 | 48 model: akış, bulaşma, kliring, CCP, marj, dijital ikiz, gözetim, M21 breadth |
| Gerçek veri ve doğrulama | 3 | Yalnızca 13 ay TEFAS; BIST, portföy, KAP yok; gerçek olay testi yok |
| Operasyonel olgunluk | 2 | Ücretsiz bulut, 1 GB veritabanı, kararsız giriş, izleme yok |
| Ürün / arayüz | 4 | İşlevsel, olgun değil |

## Faz 0: Temeli sağlamlaştır (2–4 hafta)

| İş | Çıktı | Kim |
|---|---|---|
| Canlı giriş kararsızlığını bul ve düzelt | İlk denemede giriş | Ben |
| Makinedeki `vnextCore` zaman aşımı testini düzelt | CI ve yerelde tüm testler yeşil | Ben |
| Bulut veritabanı planı (Neon ücretli) veya yalnızca-sonuç mimarisi | 1 GB sınırı sorunu biter | Sen (plan) / Ben |
| Hata izleme ve basit uptime uyarısı | Çökme olunca haber gelir | Ben |
| TEFAS geçmişini 3–5 yıla çıkar (aylık indirme, güvenlik duvarına saygılı) | 36–60 ay TEFAS | Ben (yavaş, kısmen elle) |

**Çıkış ölçütü:** 36+ ay TEFAS verisi yerel veritabanında, canlı sistem 2 hafta kesintisiz.

## Faz 1: Veri temeli (1–3 ay)

| Veri | Kaynak | Not | Kim |
|---|---|---|---|
| BIST günlük fiyat/hacim | Borsa İstanbul DataStore | Lisans ve ücret gerekir | Sen (satın alma) / Ben (yükleme) |
| KAP bildirimleri, fon portföy dağılımı | MKK API Portal (KAP REST) | Hesap açma + onay | Sen (başvuru) / Ben (bağlama) |
| Makro/kur/faiz | TCMB EVDS (ücretsiz API anahtarı) | Hızlı kazanç | Sen (anahtar) / Ben |
| Serbest dolaşım, takas | MKK / Takasbank | Başvuru taslakları `DATA_REQUESTS.md` içinde | Sen |

**Çıkış ölçütü:** Senaryo sekmesi gerçek veriyle çalışır (`from-data`), fon evreni dolu, veri kapsam raporu otomatik.

## Faz 2: Gerçek olaylarda kanıt (2–4 ay) **en kritik faz**

1. **Olay kataloğu:** bilinen stres olayları listesi (sen onaylarsın; örn. 2018 kur şoku, 2020 Mart, 2021 Aralık kur şoku, 2023 deprem/seçim dönemi, 2025 Mart dalgalanması). Her biri için tarih ve kaynak.
2. **Önceden yazılmış protokol:** hangi motor, hangi eşik, hangi ölçüt; sonuca bakmadan sabitle.
3. **Kör yeniden oynatma** (altyapı hazır: `realReplay`): her olayda uyarının ne zaman geldiği, ne kadar önce, yanlış alarm sayısı/yıl.
4. **Kalibrasyon:** M20 eşikleri ve M21 yaygınlık eşiği ampirik olarak (başlangıç: `anomaly-threshold-calibration`, `breadth-trial`).
5. **Yönetişim:** modeller DEVELOPMENT → VALIDATION → SHADOW (insan onaylı).

**Çıkış ölçütü:** her olay için "erken uyarı süresi / yanlış alarm/yıl" tablosu, en az 3 bağımsız olayda sistem seviyesi alarm; metrikler önceden belirlenen eşiği geçiyor.

## Faz 3: Ürün olgunluğu (3–6 ay)

- Kullanıcı arayüzü: alarm panosu, "neden?" açıklamaları, olay zaman çizelgesi, e-posta/mobil bildirim.
- Performans ve ölçek: koşu kuyruğu, önbellek, büyük veri için yerel/bulut ayrımı (senkron altyapısı hazır).
- Roller ve denetim: denetim kaydı dışa aktarma, çok kullanıcılı yetki.
- Türkçe ve İngilizce raporlar (kurumlara sunulabilir PDF).

**Çıkış ölçütü:** 3 gerçek kullanıcı (kendi ekibinin dışından) günlük kullanıyor, geri bildirim toplandı.

## Faz 4: Bağımsız doğrulama ve pilot (6–12 ay)

- Bağımsız model doğrulama (akademik veya model-risk ekibi), bulguların kapatılması.
- Sızma testi, yedekleme ve felaket kurtarma, SLA.
- Bir kurumla pilot (SPK, Borsa İstanbul, Takasbank veya varlık yöneticisi).

**Çıkış ölçütü:** bağımsız doğrulama raporu, pilot kurumdan yazılı geri bildirim.

## Ölçülecek göstergeler

| Gösterge | Şimdi | Faz 2 hedefi |
|---|---|---|
| Gerçek olay sayısı (test edilen) | 0 | ≥ 5 |
| Sistem seviyesi erken uyarı süresi | ölçülmedi | medyan ≥ 1 hafta |
| Yanlış alarm / yıl (sistem seviyesi) | ölçülemedi (7 sakin hafta) | ≤ 2 |
| Veri geçmişi | 13 ay TEFAS | ≥ 36 ay TEFAS + BIST + portföy |
| Testi onaylı (SHADOW) model sayısı | 0 | ≥ 3 |

## Riskler

- **Veri erişimi:** lisans/onay süreleri belirsiz ve ücretli. Önlem: TCMB EVDS gibi ücretsiz kaynakla başla.
- **Küçük örneklem:** Türkiye'de büyük olay sayısı az. Önlem: sonuçları dürüstçe "kanıt düzeyi" ile raporla, aşırı uyum yapma.
- **"%100 yakalama, sıfır yanlış alarm" beklentisi:** mümkün değil (bkz. eşik eğrisi). Hedefi sistem seviyesinde ve kabul edilebilir yanlış alarm oranında koy.
- **Tek kişilik operasyon:** Önlem: otomasyon, izleme, yedekleme.
- **Düzenleyici/hukuki:** çıktılar yatırım tavsiyesi veya suç isnadı değildir (arayüzde zaten yazılı); kurumsal kullanımda hukuki inceleme gerekir.

## Önerilen ilk üç adım

1. **TCMB EVDS API anahtarı** (ücretsiz) + TEFAS'ı 36 aya çıkarma.
2. **Olay kataloğunu** birlikte netleştirme (hangi tarihler).
3. **MKK API Portal hesabı** (başvuru) ve **Borsa İstanbul DataStore** fiyat/paket bilgisini öğrenme.
