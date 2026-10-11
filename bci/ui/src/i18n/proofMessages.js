import {useLang} from './LangContext.jsx';
import en from './locales/en.js';
import {pentestText} from './pentestMessages.js';
const rows={
 'CONTROLLED PROOF OF IMPACT':['KONTROLLÜ ETKİ DOĞRULAMASI','PREUVE CONTRÔLÉE D’IMPACT','KONTROLLIERTER AUSWIRKUNGSNACHWEIS','إثبات الأثر الخاضع للتحكم'],
 'RESTRICTED ADMIN MODULE':['KISITLI YÖNETİCİ MODÜLÜ','MODULE ADMINISTRATEUR RESTREINT','BESCHRÄNKTES ADMINISTRATORMODUL','وحدة المسؤول المقيدة'],
 'LOCKED':['KİLİTLİ','VERROUILLÉ','GESPERRT','مقفل'],
 'System Administrator access required':['Sistem yöneticisi erişimi gerekir','Accès administrateur système requis','Systemadministratorzugriff erforderlich','يلزم وصول مسؤول النظام'],
 'Proof Type':['Doğrulama türü','Type de preuve','Nachweistyp','نوع الإثبات'],
 'Web Content Impact':['Web içeriği etkisi','Impact sur le contenu web','Auswirkung auf Webinhalte','أثر محتوى الويب'],
 'Proof History':['Doğrulama geçmişi','Historique des preuves','Nachweisverlauf','سجل الإثبات'],
 'No controlled proof history.':['Kontrollü doğrulama geçmişi yok.','Aucun historique de preuve contrôlée.','Kein Verlauf kontrollierter Nachweise.','لا يوجد سجل إثبات خاضع للتحكم.'],
 'Security Impact':['Güvenlik etkisi','Impact de sécurité','Sicherheitsauswirkung','الأثر الأمني'],
 'Proof ID':['Doğrulama kimliği','Identifiant de preuve','Nachweis-ID','معرف الإثبات'],
 'Customer-Visible Public Proof':['Müşteriye görünür kamuya açık doğrulama','Preuve publique visible par le client','Für Kunden sichtbarer öffentlicher Nachweis','إثبات عام مرئي للعميل'],
 'Public Visibility':['Kamuya açık görünürlük','Visibilité publique','Öffentliche Sichtbarkeit','الرؤية العامة'],
 'Public Validator':['Kamuya açık doğrulayıcı','Validateur public','Öffentlicher Prüfer','المتحقق العام'],
 'Duration':['Süre','Durée','Dauer','المدة'],
 '5 seconds':['5 saniye','5 secondes','5 Sekunden','5 ثوانٍ'], '10 seconds':['10 saniye','10 secondes','10 Sekunden','10 ثوانٍ'], '30 seconds':['30 saniye','30 secondes','30 Sekunden','30 ثانية'],
 'START PUBLIC PROOF':['KAMUYA AÇIK DOĞRULAMAYI BAŞLAT','DÉMARRER LA PREUVE PUBLIQUE','ÖFFENTLICHEN NACHWEIS STARTEN','بدء الإثبات العام'],
 'STOP PUBLIC PROOF':['KAMUYA AÇIK DOĞRULAMAYI DURDUR','ARRÊTER LA PREUVE PUBLIQUE','ÖFFENTLICHEN NACHWEIS STOPPEN','إيقاف الإثبات العام'],
 'Independent Public Observation':['Bağımsız kamuya açık gözlem','Observation publique indépendante','Unabhängige öffentliche Beobachtung','ملاحظة عامة مستقلة'],
 'Public Evidence Hash':['Kamuya açık kanıt hash’i','Empreinte de preuve publique','Hash des öffentlichen Nachweises','بصمة الدليل العام'],
 'Public Proof Failure':['Kamuya açık doğrulama hatası','Échec de la preuve publique','Fehler beim öffentlichen Nachweis','فشل الإثبات العام'],
 'Canonical Target':['Kanonik hedef','Cible canonique','Kanonisches Ziel','الهدف القياسي'],
 'Endpoints Discovered':['Keşfedilen uç noktalar','Points de terminaison découverts','Erkannte Endpunkte','نقاط النهاية المكتشفة'],
 'Live and Historical Evidence Matched':['Eşleşen canlı ve tarihsel kanıtlar','Preuves actuelles et historiques correspondantes','Übereinstimmende aktuelle und historische Nachweise','الأدلة الحالية والتاريخية المتطابقة'],
 'Content-Impact Signals':['İçerik etkisi sinyalleri','Signaux d’impact sur le contenu','Signale für Inhaltsauswirkungen','إشارات أثر المحتوى'],
 'Proof Candidates':['Doğrulama adayları','Candidats de preuve','Nachweiskandidaten','مرشحو الإثبات'],
 'Detected Delivery Providers':['Tespit edilen dağıtım sağlayıcıları','Fournisseurs de distribution détectés','Erkannte Bereitstellungsanbieter','موفرو التوزيع المكتشفون'],
 'Authoritative Nameservers':['Yetkili ad sunucuları','Serveurs de noms faisant autorité','Autoritative Nameserver','خوادم الأسماء المعتمدة'],
 'Public Adapter':['Kamuya açık adaptör','Adaptateur public','Öffentlicher Adapter','المحول العام'],
 'Public visibility support matrix':['Kamuya açık görünürlük destek matrisi','Matrice de prise en charge de la visibilité publique','Unterstützungsmatrix für öffentliche Sichtbarkeit','مصفوفة دعم الرؤية العامة'],
 'Provider':['Sağlayıcı','Fournisseur','Anbieter','الموفر'], 'Adapter':['Adaptör','Adaptateur','Adapter','المحول'],
 'Technical limitation':['Teknik sınırlama','Limitation technique','Technische Einschränkung','قيد تقني'],
 'Live Engine':['Çalışan motor','Moteur actif','Aktive Engine','المحرك الفعلي'], 'Raw Records':['Ham kayıtlar','Enregistrements bruts','Rohdatensätze','السجلات الخام'],
 'Attempted Checks':['Denenen kontroller','Contrôles tentés','Versuchte Prüfungen','الفحوص المجربة'], 'Observations':['Gözlemler','Observations','Beobachtungen','الملاحظات'],
 'Finding Evidence':['Bulgu kanıtı','Preuve de constat','Befundnachweis','دليل النتيجة'],
 'Finding Evidence records scanner observations. Controlled Proof of Impact is a separate deterministic validation result.':['Bulgu kanıtı tarayıcı gözlemlerini kaydeder. Kontrollü etki doğrulaması ayrı bir belirleyici doğrulama sonucudur.','La preuve de constat enregistre les observations du scanner. La preuve contrôlée d’impact est un résultat de validation déterministe distinct.','Befundnachweise erfassen Scannerbeobachtungen. Kontrollierte Auswirkungsnachweise sind eigenständige deterministische Prüfergebnisse.','يسجل دليل النتيجة ملاحظات الفاحص. إثبات الأثر الخاضع للتحكم هو نتيجة تحقق حتمية مستقلة.'],
 'Technical Evidence':['Teknik kanıt','Preuve technique','Technischer Nachweis','الدليل التقني'], 'Evidence Hash':['Kanıt hash’i','Empreinte de preuve','Nachweis-Hash','بصمة الدليل'],
 'Possible Security Impact':['Olası güvenlik etkisi','Impact de sécurité possible','Mögliche Sicherheitsauswirkung','الأثر الأمني المحتمل'],
 'Detected Technology':['Tespit edilen teknoloji','Technologie détectée','Erkannte Technologie','التقنية المكتشفة'],
 'Recommended Remediation':['Önerilen düzeltme','Correction recommandée','Empfohlene Behebung','المعالجة الموصى بها'],
 'Post-fix Revalidation':['Düzeltme sonrası doğrulama','Revalidation après correction','Erneute Prüfung nach Behebung','إعادة التحقق بعد الإصلاح'],
 'Verification':['Doğrulama','Vérification','Verifizierung','التحقق'], 'Proof Eligibility':['Doğrulama uygunluğu','Éligibilité de la preuve','Nachweiseignung','أهلية الإثبات'],
 'Candidates':['Adaylar','Candidats','Kandidaten','المرشحون'], 'Rejected':['Reddedilenler','Rejetés','Abgelehnt','المرفوضون'],
 'Candidate rejection reasons':['Aday ret nedenleri','Motifs de rejet des candidats','Gründe für Kandidatenablehnung','أسباب رفض المرشحين'],
 'ANALYZING…':['ANALİZ EDİLİYOR…','ANALYSE EN COURS…','ANALYSE LÄUFT…','جارٍ التحليل…'], 'ANALYZING':['ANALİZ EDİLİYOR','ANALYSE EN COURS','ANALYSE LÄUFT','جارٍ التحليل'],
 'ANALYZE TARGET':['HEDEFİ ANALİZ ET','ANALYSER LA CIBLE','ZIEL ANALYSIEREN','تحليل الهدف'],
 'Security Validator':['Güvenlik doğrulayıcı','Validateur de sécurité','Sicherheitsprüfer','المتحقق الأمني'],
 'Persistent Modification':['Kalıcı değişiklik','Modification persistante','Dauerhafte Änderung','تعديل دائم'],
 'Started':['Başlangıç','Début','Gestartet','بدأ'], 'Completed':['Tamamlanma','Fin','Abgeschlossen','اكتمل'],
 'Analysis Details':['Analiz ayrıntıları','Détails de l’analyse','Analysedetails','تفاصيل التحليل'],
 'Inspect':['İncele','Examiner','Prüfen','فحص'], 'Validator':['Doğrulayıcı','Validateur','Prüfer','المتحقق'],
 'NO SUPPORTED PROOF PATH':['DESTEKLENEN DOĞRULAMA YOLU YOK','AUCUN CHEMIN DE PREUVE PRIS EN CHARGE','KEIN UNTERSTÜTZTER NACHWEISPFAD','لا يوجد مسار إثبات مدعوم'],
 'POTENTIAL — NOT VERIFIED':['OLASI — DOĞRULANMADI','POTENTIEL — NON VÉRIFIÉ','MÖGLICH — NICHT VERIFIZIERT','محتمل — غير متحقق'],
 'VERIFIED IMPACT PATH':['DOĞRULANMIŞ ETKİ YOLU','CHEMIN D’IMPACT VÉRIFIÉ','VERIFIZIERTER AUSWIRKUNGSPFAD','مسار أثر متحقق'],
 'NOT VERIFIED':['DOĞRULANMADI','NON VÉRIFIÉ','NICHT VERIFIZIERT','غير متحقق'],
};
const keys=Object.fromEntries(Object.entries(en).map(([key,value])=>[value,key]));
export function useProofText() {
  const {lang,t}=useLang();
  return (text)=>{
    if(lang === 'en') return text;
    const colon=text.endsWith(':'),base=colon ? text.slice(0,-1) : text;
    const translated=rows[base]?.[['tr','fr','de','ar'].indexOf(lang)] || (keys[base] ? t(keys[base]) : pentestText(lang,base));
    return `${translated}${colon ? ':' : ''}`;
  };
}
