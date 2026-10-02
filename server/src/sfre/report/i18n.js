/**
 * Report strings in the five app languages. {name} placeholders are filled by tr(). Arabic is rendered right-to-left (see RTL_LANGS).
 * Keep every language in sync: reportI18n.test.js fails when a key is missing or a placeholder differs from the Turkish text.
 */
export const LANGS = Object.freeze(['tr', 'en', 'de', 'fr', 'ar']);
export const DEFAULT_LANG = 'tr';
export const RTL_LANGS = new Set(['ar']);
export const normLang = (l) => (LANGS.includes(String(l || '').slice(0, 2).toLowerCase()) ? String(l).slice(0, 2).toLowerCase() : DEFAULT_LANG);

const STR = {
  tr: {
    brandSub: 'BOLD FINANCIAL INTELLIGENCE · SİSTEMİK RİSK İZLEME', docTitle: 'Durum Raporu', docNo: 'Belge No', generated: 'Üretim',
    level0: 'NORMAL', level1: 'İZLEME', level2: 'ALARM',
    sStatus: 'Genel Durum', thIndicator: 'Gösterge', thLevel: 'Seviye', thDesc: 'Açıklama', rowBreadth: 'Fon çıkışı yaygınlığı (TEFAS)', rowFx: 'Kur şoku (TCMB EVDS)',
    weekLine: '{date} haftası: {b} ({n} fon izleniyor)', fxLine: 'Son veri {date}; son {d} günde {n} şok', noData: 'Veri yok',
    s1: '1. Fon çıkışı yaygınlığı', p1: 'Aynı hafta içinde fonların ne kadarının kendi normalinin belirgin altında çıkış yaşadığını gösterir. Tek bir fonun gürültüsü bu ölçüyü bozmaz; piyasa genelinde ortak bir hareket yaygınlığı yükseltir.',
    kpiLast: 'Son hafta ({date})', kpiBase: 'Normal dönem ortalaması', kpiAlarm: 'Alarm seviyesi', alarmLine: 'alarm seviyesi {a}', barsNote: 'Kırmızı sütunlar alarm üreten haftalardır.', watchNote: ' İzleme seviyesi {w} ve üzeridir.',
    s2: '2. Kur hareketi', p2: '{series} serisinde günlük hareketin, önceki 250 günün olağan oynaklığına göre büyüklüğü izlenir. Kırmızı noktalar şok günleridir.',
    s3: '3. Veri kapsamı', thSource: 'Kaynak', thField: 'Alan', thCount: 'Gözlem', thFirst: 'İlk', thLast: 'Son', noRecords: 'Kayıt yok',
    s4: '4. Bakılacaklar', todoNormal: 'Şu an için bir işlem gerekmiyor; bir sonraki veri güncellemesini bekleyin.',
    todo1: 'Çıkışı en yüksek fonların listesini ve para piyasası fonlarındaki hareketi kontrol edin.', todo2: 'Kur ve faiz gelişmelerini (TCMB duyuruları, KAP) aynı gün içinde karşılaştırın.', todo3: 'Alarm sürerse bir sonraki hafta verisiyle teyit edin; tek haftalık alarm kesin sonuç değildir.', todoNote: 'Bu liste yatırım tavsiyesi değildir; incelenecek noktaları gösterir.',
    s5: '5. Güvenilirlik ve sınırlar', unknownModels: 'durum bilgisi yok',
    note: 'Önemli: Bu sistemdeki modeller henüz kalibre edilmemiştir ({models}). Fon çıkışı alarmı şu ana kadar yalnız tek bir gerçek olayda (Eylül 2026) test edilmiş ve alarm olayla aynı hafta gelmiştir; erken uyarı süresi kanıtlanmamıştır. Kur şoku tanıma 5 olayın 4\'ünde başarılıdır, ancak şoku önceden öngörmez. Bağımsız doğrulama yapılmamıştır. Raporu karar için tek başına dayanak yapmayın.',
    s6: '6. Yöntem', thTopic: 'Konu', thDescription: 'Açıklama', mBreadthK: 'Fon yaygınlığı', mFxK: 'Kur şoku', mDataK: 'Veri',
    mBreadth: "Her fon için haftalık net akışın kendi medyan/MAD'ine göre z skoru; z ≤ −3 olan fonların payı. Alarm seviyesi referans döneminden öğrenilir (ortalama + 4σ, ortalamanın 2 katı ya da +5 puanın en büyüğü). İzleme seviyesi ortalama + 2σ'dır (kabul edilmiş bir eşik, kalibre değil).",
    mFx: "Günlük log getirinin önceki 250 günün medyan/MAD'ine göre ≥ 5 robust sigma ve ≥ %2 olması. Yalnız geçmiş veri kullanılır.", mData: 'TEFAS fon verileri, TCMB EVDS kurları. Gözlemler yayın zamanı damgalıdır; sonradan düzeltmeler eski sonucu değiştirmez.',
    footer: 'BFI Durum Raporu · Belge No {id} · Otomatik üretilmiştir ve {date} tarihine kadar olan veriyi yansıtır. Sürüm {v}. Yatırım tavsiyesi değildir.', page: 'Sayfa {i} / {n}',
    dBreadthAlarm: 'Fonların {b} kadarı aynı anda kendi normalinin belirgin altında çıkış gösteriyor (alarm seviyesi {alarm}, normal dönem ortalaması {mean}).',
    dBreadthWatch: 'Çıkış gösteren fon payı {b}; alarm seviyesinin ({alarm}) altında ama normalin üzerinde (ortalama {mean}).', dStale: 'Fon verisi {days} gün eski; bu bölümün güncel olduğu söylenemez.',
    dFxShock: '{date} tarihinde kurda {move} hareket (olağan oynaklığın {z} katı).', dNoData: 'Değerlendirilecek veri yok.', dAllNormal: 'Hiçbir gösterge alışılmadık bir hareket göstermiyor.',
    mailSubject: '[BFI] Sistem seviyesi: {level}', mailChange: '({from} → {to})', mailRaised: 'yükseldi', mailLowered: 'düştü', mailFirst: 'ilk değerlendirme', mailHead: 'BFI sistem seviyesi {dir}: {level}.',
    mailAttached: 'Ayrıntılı rapor ektedir (tarayıcıda açıp yazdırarak PDF alabilirsiniz).', mailDisclaimer: 'Modeller henüz kalibre edilmemiştir; bu bildirim yatırım tavsiyesi değildir.', mailFile: 'BFI-Durum-Raporu',
  },
  en: {
    brandSub: 'BOLD FINANCIAL INTELLIGENCE · SYSTEMIC RISK MONITORING', docTitle: 'Situation Report', docNo: 'Document no.', generated: 'Generated',
    level0: 'NORMAL', level1: 'WATCH', level2: 'ALARM',
    sStatus: 'Overall Status', thIndicator: 'Indicator', thLevel: 'Level', thDesc: 'Description', rowBreadth: 'Breadth of fund outflows (TEFAS)', rowFx: 'FX shock (CBRT EVDS)',
    weekLine: 'Week of {date}: {b} ({n} funds monitored)', fxLine: 'Latest data {date}; {n} shocks in the last {d} days', noData: 'No data',
    s1: '1. Breadth of fund outflows', p1: 'Shows what share of funds are, in the same week, experiencing outflows clearly below their own normal. The noise of a single fund does not distort this measure; a common market-wide move raises the breadth.',
    kpiLast: 'Latest week ({date})', kpiBase: 'Normal-period average', kpiAlarm: 'Alarm level', alarmLine: 'alarm level {a}', barsNote: 'Red bars are the weeks that triggered an alarm.', watchNote: ' The watch level is {w} and above.',
    s2: '2. Exchange-rate movement', p2: 'For the series {series}, the size of the daily move relative to the usual volatility of the previous 250 days is monitored. Red dots are shock days.',
    s3: '3. Data coverage', thSource: 'Source', thField: 'Field', thCount: 'Observations', thFirst: 'First', thLast: 'Last', noRecords: 'No records',
    s4: '4. Points to check', todoNormal: 'No action is needed for now; wait for the next data update.',
    todo1: 'Check the list of funds with the highest outflows and the movement in money market funds.', todo2: 'Compare exchange-rate and interest-rate developments (CBRT announcements, KAP disclosures) on the same day.', todo3: 'If the alarm persists, confirm it with the next week\'s data; a one-week alarm is not a conclusive result.', todoNote: 'This list is not investment advice; it points to items to examine.',
    s5: '5. Reliability and limits', unknownModels: 'status unavailable',
    note: 'Important: The models in this system have not been calibrated yet ({models}). The fund-outflow alarm has so far been tested on only one real event (September 2026), and the alarm came in the same week as the event; lead time has not been demonstrated. FX shock detection succeeds in 4 of 5 events but does not predict shocks in advance. No independent validation has been performed. Do not rely on this report alone for decisions.',
    s6: '6. Method', thTopic: 'Topic', thDescription: 'Description', mBreadthK: 'Fund breadth', mFxK: 'FX shock', mDataK: 'Data',
    mBreadth: 'For each fund, the z-score of weekly net flow against its own median/MAD; the share of funds with z ≤ −3. The alarm level is learned from the reference period (the largest of mean + 4σ, twice the mean, or +5 points). The watch level is mean + 2σ (an accepted threshold, not calibrated).',
    mFx: 'The daily log return being ≥ 5 robust sigmas relative to the median/MAD of the previous 250 days and ≥ 2%. Only past data is used.', mData: 'TEFAS fund data, TCMB EVDS exchange rates. Observations carry a publication timestamp; later corrections do not change an earlier result.',
    footer: 'BFI Situation Report · Document no. {id} · Generated automatically, reflecting data up to {date}. Version {v}. Not investment advice.', page: 'Page {i} / {n}',
    dBreadthAlarm: '{b} of funds are simultaneously showing outflows clearly below their own normal (alarm level {alarm}, normal-period average {mean}).',
    dBreadthWatch: 'The share of funds with outflows is {b}; below the alarm level ({alarm}) but above normal (average {mean}).', dStale: 'The fund data is {days} days old; this section cannot be considered current.',
    dFxShock: 'On {date}, the exchange rate moved {move} ({z} times the usual volatility).', dNoData: 'There is no data to assess.', dAllNormal: 'No indicator shows an unusual movement.',
    mailSubject: '[BFI] System level: {level}', mailChange: '({from} → {to})', mailRaised: 'rose', mailLowered: 'fell', mailFirst: 'first assessment', mailHead: 'BFI system level {dir}: {level}.',
    mailAttached: 'The detailed report is attached (open it in a browser and print to get a PDF).', mailDisclaimer: 'The models have not been calibrated yet; this notification is not investment advice.', mailFile: 'BFI-Situation-Report',
  },
  de: {
    brandSub: 'BOLD FINANCIAL INTELLIGENCE · ÜBERWACHUNG SYSTEMISCHER RISIKEN', docTitle: 'Lagebericht', docNo: 'Dokument-Nr.', generated: 'Erstellt',
    level0: 'NORMAL', level1: 'BEOBACHTUNG', level2: 'ALARM',
    sStatus: 'Gesamtlage', thIndicator: 'Indikator', thLevel: 'Stufe', thDesc: 'Beschreibung', rowBreadth: 'Breite der Fondsabflüsse (TEFAS)', rowFx: 'Wechselkursschock (TCMB EVDS)',
    weekLine: 'Woche {date}: {b} ({n} Fonds überwacht)', fxLine: 'Letzte Daten {date}; {n} Schocks in den letzten {d} Tagen', noData: 'Keine Daten',
    s1: '1. Breite der Fondsabflüsse', p1: 'Zeigt, welcher Anteil der Fonds in derselben Woche Abflüsse deutlich unter ihrem eigenen Normalwert verzeichnet. Das Rauschen eines einzelnen Fonds verzerrt dieses Maß nicht; eine gemeinsame Marktbewegung erhöht die Breite.',
    kpiLast: 'Letzte Woche ({date})', kpiBase: 'Durchschnitt der Normalperiode', kpiAlarm: 'Alarmschwelle', alarmLine: 'Alarmschwelle {a}', barsNote: 'Rote Balken sind Wochen, die einen Alarm ausgelöst haben.', watchNote: ' Die Beobachtungsschwelle liegt bei {w} und darüber.',
    s2: '2. Wechselkursbewegung', p2: 'Für die Reihe {series} wird die Größe der Tagesbewegung im Verhältnis zur üblichen Schwankung der vorangegangenen 250 Tage überwacht. Rote Punkte sind Schocktage.',
    s3: '3. Datenabdeckung', thSource: 'Quelle', thField: 'Feld', thCount: 'Beobachtungen', thFirst: 'Erste', thLast: 'Letzte', noRecords: 'Keine Einträge',
    s4: '4. Zu prüfen', todoNormal: 'Derzeit ist keine Maßnahme erforderlich; warten Sie die nächste Datenaktualisierung ab.',
    todo1: 'Prüfen Sie die Liste der Fonds mit den höchsten Abflüssen und die Entwicklung bei Geldmarktfonds.', todo2: 'Vergleichen Sie Wechselkurs- und Zinsentwicklungen (TCMB-Mitteilungen, KAP) am selben Tag.', todo3: 'Hält der Alarm an, bestätigen Sie ihn mit den Daten der nächsten Woche; ein Ein-Wochen-Alarm ist kein endgültiges Ergebnis.', todoNote: 'Diese Liste ist keine Anlageberatung; sie zeigt Punkte, die zu prüfen sind.',
    s5: '5. Zuverlässigkeit und Grenzen', unknownModels: 'Status nicht verfügbar',
    note: 'Wichtig: Die Modelle dieses Systems sind noch nicht kalibriert ({models}). Der Alarm für Fondsabflüsse wurde bisher nur an einem realen Ereignis (September 2026) getestet; der Alarm kam in derselben Woche wie das Ereignis, eine Vorlaufzeit ist nicht nachgewiesen. Die Erkennung von Wechselkursschocks gelingt bei 4 von 5 Ereignissen, sagt Schocks aber nicht voraus. Eine unabhängige Validierung hat nicht stattgefunden. Stützen Sie Entscheidungen nicht allein auf diesen Bericht.',
    s6: '6. Methode', thTopic: 'Thema', thDescription: 'Beschreibung', mBreadthK: 'Fondsbreite', mFxK: 'Wechselkursschock', mDataK: 'Daten',
    mBreadth: 'Für jeden Fonds der z-Wert des wöchentlichen Nettomittelflusses gegenüber dem eigenen Median/MAD; Anteil der Fonds mit z ≤ −3. Die Alarmschwelle wird aus dem Referenzzeitraum gelernt (der größte Wert aus Mittelwert + 4σ, doppeltem Mittelwert oder +5 Punkten). Die Beobachtungsschwelle ist Mittelwert + 2σ (eine festgelegte Schwelle, nicht kalibriert).',
    mFx: 'Der tägliche Log-Ertrag liegt ≥ 5 robuste Sigma über dem Median/MAD der vorangegangenen 250 Tage und beträgt ≥ 2 %. Es werden nur vergangene Daten verwendet.', mData: 'TEFAS-Fondsdaten, TCMB-EVDS-Wechselkurse. Beobachtungen tragen einen Veröffentlichungszeitstempel; spätere Korrekturen ändern ein früheres Ergebnis nicht.',
    footer: 'BFI Lagebericht · Dokument-Nr. {id} · Automatisch erstellt, Datenstand {date}. Version {v}. Keine Anlageberatung.', page: 'Seite {i} / {n}',
    dBreadthAlarm: '{b} der Fonds verzeichnen gleichzeitig Abflüsse deutlich unter ihrem eigenen Normalwert (Alarmschwelle {alarm}, Durchschnitt der Normalperiode {mean}).',
    dBreadthWatch: 'Der Anteil der Fonds mit Abflüssen beträgt {b}; unter der Alarmschwelle ({alarm}), aber über dem Normalwert (Durchschnitt {mean}).', dStale: 'Die Fondsdaten sind {days} Tage alt; dieser Abschnitt kann nicht als aktuell gelten.',
    dFxShock: 'Am {date} bewegte sich der Wechselkurs um {move} (das {z}-Fache der üblichen Schwankung).', dNoData: 'Es liegen keine Daten zur Bewertung vor.', dAllNormal: 'Kein Indikator zeigt eine ungewöhnliche Bewegung.',
    mailSubject: '[BFI] Systemstufe: {level}', mailChange: '({from} → {to})', mailRaised: 'gestiegen', mailLowered: 'gesunken', mailFirst: 'Erstbewertung', mailHead: 'BFI-Systemstufe {dir}: {level}.',
    mailAttached: 'Der ausführliche Bericht ist angehängt (im Browser öffnen und drucken, um ein PDF zu erhalten).', mailDisclaimer: 'Die Modelle sind noch nicht kalibriert; diese Benachrichtigung ist keine Anlageberatung.', mailFile: 'BFI-Lagebericht',
  },
  fr: {
    brandSub: 'BOLD FINANCIAL INTELLIGENCE · SURVEILLANCE DU RISQUE SYSTÉMIQUE', docTitle: 'Rapport de situation', docNo: 'N° de document', generated: 'Généré',
    level0: 'NORMAL', level1: 'SURVEILLANCE', level2: 'ALERTE',
    sStatus: 'Situation générale', thIndicator: 'Indicateur', thLevel: 'Niveau', thDesc: 'Description', rowBreadth: 'Ampleur des sorties de fonds (TEFAS)', rowFx: 'Choc de change (TCMB EVDS)',
    weekLine: 'Semaine du {date} : {b} ({n} fonds suivis)', fxLine: 'Dernières données {date} ; {n} chocs sur les {d} derniers jours', noData: 'Aucune donnée',
    s1: '1. Ampleur des sorties de fonds', p1: 'Indique quelle part des fonds subit, la même semaine, des sorties nettement inférieures à leur propre norme. Le bruit d\'un seul fonds ne fausse pas cette mesure ; un mouvement commun à l\'ensemble du marché fait monter l\'ampleur.',
    kpiLast: 'Dernière semaine ({date})', kpiBase: 'Moyenne de la période normale', kpiAlarm: 'Seuil d\'alerte', alarmLine: 'seuil d\'alerte {a}', barsNote: 'Les barres rouges sont les semaines ayant déclenché une alerte.', watchNote: ' Le seuil de surveillance est de {w} et au-delà.',
    s2: '2. Évolution du taux de change', p2: 'Pour la série {series}, on suit l\'ampleur du mouvement quotidien par rapport à la volatilité habituelle des 250 jours précédents. Les points rouges sont des jours de choc.',
    s3: '3. Couverture des données', thSource: 'Source', thField: 'Champ', thCount: 'Observations', thFirst: 'Première', thLast: 'Dernière', noRecords: 'Aucun enregistrement',
    s4: '4. Points à vérifier', todoNormal: 'Aucune action n\'est nécessaire pour l\'instant ; attendez la prochaine mise à jour des données.',
    todo1: 'Vérifiez la liste des fonds aux sorties les plus élevées et l\'évolution des fonds monétaires.', todo2: 'Comparez le même jour les évolutions des taux de change et des taux d\'intérêt (annonces de la TCMB, KAP).', todo3: 'Si l\'alerte persiste, confirmez-la avec les données de la semaine suivante ; une alerte d\'une semaine n\'est pas un résultat définitif.', todoNote: 'Cette liste ne constitue pas un conseil en investissement ; elle indique des points à examiner.',
    s5: '5. Fiabilité et limites', unknownModels: 'statut indisponible',
    note: 'Important : les modèles de ce système ne sont pas encore calibrés ({models}). L\'alerte de sorties de fonds n\'a été testée que sur un seul événement réel (septembre 2026) et l\'alerte est survenue la même semaine que l\'événement ; aucun délai d\'anticipation n\'est démontré. La détection des chocs de change réussit sur 4 événements sur 5 mais ne les prédit pas. Aucune validation indépendante n\'a été réalisée. Ne fondez pas vos décisions sur ce seul rapport.',
    s6: '6. Méthode', thTopic: 'Sujet', thDescription: 'Description', mBreadthK: 'Ampleur des fonds', mFxK: 'Choc de change', mDataK: 'Données',
    mBreadth: 'Pour chaque fonds, le score z du flux net hebdomadaire par rapport à sa propre médiane/MAD ; part des fonds avec z ≤ −3. Le seuil d\'alerte est appris sur la période de référence (le plus grand de : moyenne + 4σ, deux fois la moyenne ou +5 points). Le seuil de surveillance est moyenne + 2σ (un seuil admis, non calibré).',
    mFx: 'Le rendement logarithmique quotidien est ≥ 5 sigmas robustes par rapport à la médiane/MAD des 250 jours précédents et ≥ 2 %. Seules les données passées sont utilisées.', mData: 'Données de fonds TEFAS, taux de change TCMB EVDS. Les observations portent un horodatage de publication ; les corrections ultérieures ne modifient pas un résultat antérieur.',
    footer: 'Rapport de situation BFI · N° de document {id} · Généré automatiquement, données jusqu\'au {date}. Version {v}. Ne constitue pas un conseil en investissement.', page: 'Page {i} / {n}',
    dBreadthAlarm: '{b} des fonds subissent simultanément des sorties nettement inférieures à leur propre norme (seuil d\'alerte {alarm}, moyenne de la période normale {mean}).',
    dBreadthWatch: 'La part des fonds en sortie est de {b} ; inférieure au seuil d\'alerte ({alarm}) mais supérieure à la normale (moyenne {mean}).', dStale: 'Les données de fonds datent de {days} jours ; cette section ne peut être considérée comme à jour.',
    dFxShock: 'Le {date}, le taux de change a varié de {move} ({z} fois la volatilité habituelle).', dNoData: 'Aucune donnée à évaluer.', dAllNormal: 'Aucun indicateur ne montre de mouvement inhabituel.',
    mailSubject: '[BFI] Niveau du système : {level}', mailChange: '({from} → {to})', mailRaised: 'a augmenté', mailLowered: 'a diminué', mailFirst: 'première évaluation', mailHead: 'Le niveau du système BFI {dir} : {level}.',
    mailAttached: 'Le rapport détaillé est joint (ouvrez-le dans un navigateur et imprimez pour obtenir un PDF).', mailDisclaimer: 'Les modèles ne sont pas encore calibrés ; cette notification ne constitue pas un conseil en investissement.', mailFile: 'BFI-Rapport-de-situation',
  },
  ar: {
    brandSub: 'BOLD FINANCIAL INTELLIGENCE · مراقبة المخاطر النظامية', docTitle: 'تقرير الوضع', docNo: 'رقم الوثيقة', generated: 'تاريخ الإنشاء',
    level0: 'عادي', level1: 'مراقبة', level2: 'إنذار',
    sStatus: 'الوضع العام', thIndicator: 'المؤشر', thLevel: 'المستوى', thDesc: 'الوصف', rowBreadth: 'اتساع الخروج من الصناديق (TEFAS)', rowFx: 'صدمة سعر الصرف (TCMB EVDS)',
    weekLine: 'أسبوع {date}: {b} (يتم رصد {n} صندوقاً)', fxLine: 'آخر بيانات {date}؛ {n} صدمات خلال آخر {d} أيام', noData: 'لا توجد بيانات',
    s1: '1. اتساع الخروج من الصناديق', p1: 'يبيّن نسبة الصناديق التي تشهد في الأسبوع نفسه تدفقات خروج أقل بوضوح من مستواها الطبيعي. لا يؤثر ضجيج صندوق واحد في هذا المقياس؛ أما الحركة المشتركة في السوق كله فترفع الاتساع.',
    kpiLast: 'آخر أسبوع ({date})', kpiBase: 'متوسط الفترة الطبيعية', kpiAlarm: 'مستوى الإنذار', alarmLine: 'مستوى الإنذار {a}', barsNote: 'الأعمدة الحمراء هي الأسابيع التي أطلقت إنذاراً.', watchNote: ' مستوى المراقبة هو {w} فأكثر.',
    s2: '2. حركة سعر الصرف', p2: 'في السلسلة {series} تُرصد قيمة الحركة اليومية قياساً بالتذبذب المعتاد في الأيام الـ250 السابقة. النقاط الحمراء هي أيام الصدمة.',
    s3: '3. تغطية البيانات', thSource: 'المصدر', thField: 'الحقل', thCount: 'الملاحظات', thFirst: 'الأولى', thLast: 'الأخيرة', noRecords: 'لا توجد سجلات',
    s4: '4. نقاط المراجعة', todoNormal: 'لا يلزم أي إجراء الآن؛ انتظر التحديث التالي للبيانات.',
    todo1: 'راجع قائمة الصناديق الأعلى خروجاً وحركة صناديق أسواق النقد.', todo2: 'قارن في اليوم نفسه تطورات سعر الصرف وأسعار الفائدة (إعلانات TCMB وKAP).', todo3: 'إذا استمر الإنذار فتأكد منه ببيانات الأسبوع التالي؛ فإنذار أسبوع واحد ليس نتيجة قاطعة.', todoNote: 'هذه القائمة ليست نصيحة استثمارية؛ إنما تشير إلى نقاط تستحق الفحص.',
    s5: '5. الموثوقية والحدود', unknownModels: 'الحالة غير متاحة',
    note: 'مهم: لم تُعَايَر نماذج هذا النظام بعد ({models}). لم يُختبر إنذار الخروج من الصناديق حتى الآن إلا على حدث واقعي واحد (سبتمبر 2026)، وجاء الإنذار في الأسبوع نفسه الذي وقع فيه الحدث؛ ولم يثبت وجود مهلة إنذار مبكر. ينجح رصد صدمات سعر الصرف في 4 من 5 أحداث لكنه لا يتنبأ بالصدمات مسبقاً. لم يجرِ أي تحقق مستقل. لا تعتمد على هذا التقرير وحده في اتخاذ القرارات.',
    s6: '6. المنهجية', thTopic: 'الموضوع', thDescription: 'الوصف', mBreadthK: 'اتساع الصناديق', mFxK: 'صدمة سعر الصرف', mDataK: 'البيانات',
    mBreadth: 'لكل صندوق تُحسب درجة z للتدفق الصافي الأسبوعي مقارنةً بوسيطه الخاص/MAD؛ ثم نسبة الصناديق التي تكون فيها z ≤ −3. يُتعلَّم مستوى الإنذار من فترة المرجع (الأكبر بين المتوسط + 4σ أو ضعف المتوسط أو +5 نقاط). مستوى المراقبة هو المتوسط + 2σ (عتبة مقبولة وليست معايَرة).',
    mFx: 'أن يكون العائد اللوغاريتمي اليومي ≥ 5 انحرافات معيارية متينة قياساً بوسيط/MAD الأيام الـ250 السابقة وأن يبلغ ≥ 2%. تُستخدم البيانات السابقة فقط.', mData: 'بيانات صناديق TEFAS وأسعار الصرف من TCMB EVDS. تحمل الملاحظات ختم وقت النشر؛ ولا تغيّر التصحيحات اللاحقة نتيجةً سابقة.',
    footer: 'تقرير الوضع BFI · رقم الوثيقة {id} · أُنشئ تلقائياً ويعكس البيانات حتى {date}. الإصدار {v}. ليس نصيحة استثمارية.', page: 'صفحة {i} / {n}',
    dBreadthAlarm: 'تشهد {b} من الصناديق في الوقت نفسه تدفقات خروج أقل بوضوح من مستواها الطبيعي (مستوى الإنذار {alarm}، متوسط الفترة الطبيعية {mean}).',
    dBreadthWatch: 'نسبة الصناديق التي تشهد خروجاً {b}؛ أقل من مستوى الإنذار ({alarm}) لكنها أعلى من الطبيعي (المتوسط {mean}).', dStale: 'بيانات الصناديق عمرها {days} يوماً؛ لا يمكن اعتبار هذا القسم حديثاً.',
    dFxShock: 'في {date} تحرك سعر الصرف بنسبة {move} ({z} أضعاف التذبذب المعتاد).', dNoData: 'لا توجد بيانات للتقييم.', dAllNormal: 'لا يُظهر أي مؤشر حركة غير معتادة.',
    mailSubject: '[BFI] مستوى النظام: {level}', mailChange: '({from} ← {to})', mailRaised: 'ارتفع', mailLowered: 'انخفض', mailFirst: 'التقييم الأول', mailHead: 'مستوى نظام BFI {dir}: {level}.',
    mailAttached: 'التقرير التفصيلي مرفق (افتحه في المتصفح واطبعه للحصول على PDF).', mailDisclaimer: 'لم تُعَايَر النماذج بعد؛ وهذا الإشعار ليس نصيحة استثمارية.', mailFile: 'BFI-Situation-Report',
  },
};

export function tr(lang, key, params = {}) {
  const s = (STR[normLang(lang)] || STR.tr)[key] ?? STR.tr[key];
  if (s === undefined) throw new Error(`missing report string ${key}`);
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
}
export const reportStrings = (lang) => STR[normLang(lang)];
export const ALL_STRINGS = STR;

const SEP = { tr: '.', de: '.', en: '/', fr: '/', ar: '/' };
/** Percent with the language's decimal mark; dates as dd.mm.yyyy (tr, de) or dd/mm/yyyy (en, fr, ar). */
export const fmtPct = (x, lang, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%`.replace('.', lang === 'en' || lang === 'ar' ? '.' : ',') : 'n/a');
export const fmtNum = (x, lang, d = 2) => (Number.isFinite(x) ? x.toFixed(d).replace('.', lang === 'en' || lang === 'ar' ? '.' : ',') : 'n/a');
export const fmtDate = (iso, lang) => { const s = String(iso || ''); if (s.length < 10) return 'n/a'; const sep = SEP[normLang(lang)]; return `${s.slice(8, 10)}${sep}${s.slice(5, 7)}${sep}${s.slice(0, 4)}`; };
