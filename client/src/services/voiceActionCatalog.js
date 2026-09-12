// ─── Canonical voice-action metadata registry (single source of truth) ────
// Every semantic voice action BQI exposes -- whichever component
// actually wires its handler (DashboardPage/AnalysisView via
// dashboardVoiceActions.js, or a self-registering component like
// PersonnelRadar.jsx/EmergencyButton.jsx/HomeView.jsx) -- has exactly ONE
// metadata entry here: name, description, param shape, which screen(s) it
// is valid on, its TR/EN/DE/FR/AR voice synonyms, whether it requires a
// spoken confirmation, and which permission (if any) it requires. Nothing
// else in the codebase hand-duplicates a synonym list: voiceUiCatalog.js's
// UI_CATALOG (used for direct phrase -> action navigation matching) is
// *derived* from `navMatch` entries here, and dashboardVoiceActions.js
// looks up description/params from here instead of repeating them inline.
//
// `navMatch: true` marks an action reachable by a fixed phrase from
// anywhere on its `validOn` screens (see voiceUiCatalog.matchUiCatalogAction).
// `navMatch: false` marks an action that is resolved compositionally
// instead (category/depth/quantum/priority/step slot-fillers combined by
// voiceAssistantEngine.js) -- its `synonyms` are still real example
// trigger phrases, used by the coverage check/tests and documentation, not
// literal substring matches.
import { SUPPORTED_LANGS } from './i18n.js';

export const SCREENS = {
  LOGIN: 'login',
  DASHBOARD_HOME: 'dashboard-home',
  DASHBOARD_ANALYSIS: 'dashboard-analysis',
};

const ALL_DASHBOARD = [SCREENS.DASHBOARD_HOME, SCREENS.DASHBOARD_ANALYSIS];

export const ACTION_CATALOG = [
  // ── Core navigation ───────────────────────────────────────────────────
  {
    name: 'navigate_home', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Go to the home / map monitoring view', params: {},
    synonyms: {
      tr: ['ana ekran', 'anasayfa', 'ana sayfa', 'harita', 'eve git', 'geri don', 'geri dön'],
      en: ['home', 'main screen', 'go home', 'map view', 'go back'],
      de: ['startseite', 'hauptbildschirm', 'nach hause', 'zuruck', 'zurück'],
      fr: ['accueil', 'ecran principal', 'écran principal', 'retour'],
      ar: ['الشاشة الرئيسية', 'الرئيسية', 'رجوع'],
    },
  },
  {
    name: 'navigate_analysis', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the analysis workspace', params: { category: 'optional: savunma|enerji|saldiri|ekonomi|toplumsal|danisma|saglik|cok-alanli|bddk|btk' },
    synonyms: {
      tr: ['analiz paneline git', 'analiz ekranina git', 'analiz ekranına git', 'analiz paneli', 'panele git'],
      en: ['go to analysis', 'analysis panel', 'open analysis panel', 'go to the panel'],
      de: ['zur analyse', 'analysebereich', 'zum panel'],
      fr: ["aller a l'analyse", "aller à l'analyse", "panneau d'analyse"],
      ar: ['اذهب إلى التحليل', 'لوحة التحليل'],
    },
  },
  {
    name: 'start_analysis', navMatch: false, validOn: ALL_DASHBOARD,
    description: 'Create/start a new analysis with a specific category, depth and quantum mode pre-selected in the wizard',
    params: { category: 'required enum: savunma|enerji|saldiri|ekonomi|toplumsal|danisma|saglik|cok-alanli|bddk|btk', depth: 'optional enum: hizli|standart|derin (default standart)', quantum: 'optional boolean (default false)', prompt: 'optional analysis topic/brief extracted from the user speech', title: 'optional report title' },
    synonyms: {
      tr: ['enerji analizi başlat', 'derin kuantum destekli enerji analizi başlat', 'savunma analizi başlat'],
      en: ['start an energy analysis', 'start a deep defense analysis with quantum'],
      de: ['starte eine tiefe Verteidigungsanalyse'],
      fr: ['lancer une analyse économie approfondie'],
      ar: ['ابدأ تحليل الطاقة'],
    },
  },
  {
    name: 'new_analysis', navMatch: false, validOn: ALL_DASHBOARD,
    description: 'Start a new analysis with no preset category', params: {},
    synonyms: {
      tr: ['yeni analiz başlat', 'yeni analiz oluştur', 'boş analiz'],
      en: ['new analysis', 'start a new analysis'],
      de: ['neue analyse starten'],
      fr: ['démarrer une nouvelle analyse'],
      ar: ['ابدأ تحليلاً جديداً'],
    },
  },
  {
    name: 'navigate_history', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the history / past analyses view', params: {},
    synonyms: {
      tr: ['gecmis', 'geçmiş', 'arsiv', 'arşiv', 'gecmise git', 'geçmişe git'],
      en: ['history', 'archive', 'go to history'],
      de: ['verlauf', 'archiv'],
      fr: ['historique', 'archives'],
      ar: ['السجل', 'الأرشيف'],
    },
  },
  {
    name: 'close_history', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the history / past analyses view', params: {},
    synonyms: {
      tr: ['gecmisi kapat', 'geçmişi kapat'],
      en: ['close history'],
      de: ['verlauf schliessen', 'verlauf schließen'],
      fr: ["fermer l'historique"],
      ar: ['أغلق السجل'],
    },
  },

  // ── Voice consultation chat ───────────────────────────────────────────
  {
    name: 'open_voice_chat', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the voice consultation chat modal', params: {},
    synonyms: {
      tr: ['sohbet', 'sesli danisma', 'sesli danışma', 'danismayi ac', 'danışmayı aç'],
      en: ['chat', 'voice chat', 'open chat'],
      de: ['chat offnen', 'chat öffnen', 'sprachberatung'],
      fr: ['ouvrir le chat', 'consultation vocale'],
      ar: ['فتح الدردشة', 'استشارة صوتية'],
    },
  },
  {
    name: 'close_voice_chat', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the voice consultation chat', params: {},
    synonyms: {
      tr: ['sohbeti kapat', 'danismayi kapat', 'danışmayı kapat'],
      en: ['close chat', 'close voice chat'],
      de: ['chat schliessen', 'chat schließen'],
      fr: ['fermer le chat'],
      ar: ['أغلق الدردشة'],
    },
  },

  // ── Guide ──────────────────────────────────────────────────────────────
  {
    name: 'open_guide', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the usage guide', params: {},
    synonyms: {
      tr: ['rehberi ac', 'rehberi aç', 'kilavuzu ac', 'kılavuzu aç', 'yardim', 'yardım'],
      en: ['open guide', 'help', 'open help'],
      de: ['anleitung offnen', 'anleitung öffnen', 'hilfe'],
      fr: ['ouvrir le guide', 'aide'],
      ar: ['فتح الدليل', 'مساعدة'],
    },
  },
  {
    name: 'close_guide', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the usage guide', params: {},
    synonyms: {
      tr: ['rehberi kapat', 'kilavuzu kapat', 'kılavuzu kapat'],
      en: ['close guide', 'close help'],
      de: ['anleitung schliessen', 'anleitung schließen'],
      fr: ['fermer le guide'],
      ar: ['أغلق الدليل'],
    },
  },

  // ── Session ────────────────────────────────────────────────────────────
  {
    name: 'logout', navMatch: true, validOn: ALL_DASHBOARD, requiresConfirmation: true,
    description: 'Log out of the system', params: {},
    synonyms: {
      tr: ['cikis yap', 'çıkış yap', 'oturumu kapat'],
      en: ['log out', 'logout', 'sign out'],
      de: ['abmelden', 'ausloggen'],
      fr: ['deconnexion', 'déconnexion', 'se deconnecter', 'se déconnecter'],
      ar: ['تسجيل الخروج'],
    },
  },

  // ── Emergency center ───────────────────────────────────────────────────
  {
    name: 'open_emergency', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the emergency center panel', params: {},
    synonyms: {
      tr: ['acil durum paneli', 'acil durumu ac', 'acil durumu aç'],
      en: ['emergency panel', 'open emergency'],
      de: ['notfallzentrum', 'notfall offnen', 'notfall öffnen'],
      fr: ["centre d'urgence", "ouvrir l'urgence"],
      ar: ['مركز الطوارئ', 'فتح الطوارئ'],
    },
  },
  {
    name: 'close_emergency', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the emergency center panel', params: {},
    synonyms: {
      tr: ['acil durumu kapat'],
      en: ['close emergency', 'close emergency panel'],
      de: ['notfall schliessen', 'notfall schließen'],
      fr: ["fermer le centre d'urgence"],
      ar: ['أغلق مركز الطوارئ'],
    },
  },

  // ── Analysis wizard / report fields ───────────────────────────────────
  {
    name: 'set_analysis_title', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Set the analysis report title text', params: { value: 'string' },
    synonyms: {
      tr: ['başlık olarak ... yaz', 'rapor başlığı ...'],
      en: ['set the report title to ...'],
      de: ['setze den berichtstitel auf ...'],
      fr: ['définir le titre du rapport sur ...'],
      ar: ['اجعل عنوان التقرير ...'],
    },
  },
  {
    name: 'set_analysis_prompt', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Set / fill the analysis topic or brief', params: { value: 'string' },
    synonyms: {
      tr: ['konu olarak ... yaz'],
      en: ['set the topic to ...'],
      de: ['setze das thema auf ...'],
      fr: ['définir le sujet sur ...'],
      ar: ['اجعل الموضوع ...'],
    },
  },
  {
    name: 'generate_analysis', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Generate / run the analysis report', params: {},
    synonyms: {
      tr: ['başlat', 'raporu üret', 'analizi çalıştır'],
      en: ['run the analysis', 'generate the report'],
      de: ['analyse starten', 'bericht erstellen'],
      fr: ["lancer l'analyse", 'générer le rapport'],
      ar: ['شغّل التحليل', 'أنشئ التقرير'],
    },
  },
  {
    name: 'toggle_quantum', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Enable or disable quantum probability mode', params: { mode: 'on|off' },
    synonyms: {
      tr: ['kuantumu aç', 'kuantumu kapat', 'kuantum destekli'],
      en: ['enable quantum', 'quantum off'],
      de: ['quantum aktivieren', 'quantum deaktivieren'],
      fr: ['activer le mode quantique', 'désactiver le mode quantique'],
      ar: ['فعّل الوضع الكمي', 'أوقف الوضع الكمي'],
    },
  },
  {
    name: 'download_analysis', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Download the analysis as a DOCX file', params: {},
    synonyms: {
      tr: ['raporu indir', 'docx indir'],
      en: ['download the report', 'download docx'],
      de: ['bericht herunterladen'],
      fr: ['télécharger le rapport'],
      ar: ['نزّل التقرير'],
    },
  },
  {
    name: 'download_analysis_pdf', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Download the analysis as a PDF file', params: {},
    synonyms: {
      tr: ['pdf olarak indir', 'raporu pdf indir'],
      en: ['download as pdf', 'download pdf'],
      de: ['als pdf herunterladen'],
      fr: ['télécharger en pdf'],
      ar: ['نزّل بصيغة بي دي إف'],
    },
  },
  {
    name: 'share_analysis', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Share the analysis report via the platform share sheet', params: {},
    synonyms: {
      tr: ['raporu paylaş'],
      en: ['share the report'],
      de: ['bericht teilen'],
      fr: ['partager le rapport'],
      ar: ['شارك التقرير'],
    },
  },
  {
    name: 'reset_analysis', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Reset / clear the current analysis', params: {},
    synonyms: {
      tr: ['sıfırla', 'temizle'],
      en: ['reset', 'clear it'],
      de: ['zurücksetzen'],
      fr: ['réinitialiser'],
      ar: ['إعادة تعيين'],
    },
  },
  {
    name: 'set_analysis_depth', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Set the analysis depth (fast/standard/deep) on the in-progress wizard', params: { value: 'enum: hizli|standart|derin' },
    synonyms: {
      tr: ['derin yap', 'hızlı yap', 'standart yap'],
      en: ['make it deep', 'make it fast'],
      de: ['mach es tief', 'mach es schnell'],
      fr: ['rends-le approfondi', 'rends-le rapide'],
      ar: ['اجعله عميقاً', 'اجعله سريعاً'],
    },
  },
  {
    name: 'set_analysis_priority', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Set the analysis priority level (low/normal/high/critical) on the in-progress wizard', params: { value: 'enum: dusuk|normal|yuksek|kritik' },
    synonyms: {
      tr: ['önceliği yüksek yap', 'önceliği kritik yap', 'düşük öncelik'],
      en: ['set priority to high', 'set priority to critical'],
      de: ['priorität auf hoch setzen'],
      fr: ['définir la priorité sur élevée'],
      ar: ['اجعل الأولوية عالية'],
    },
  },
  {
    name: 'wizard_next', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Move the analysis wizard to the next step', params: {},
    synonyms: {
      tr: ['sonraki', 'ileri'],
      en: ['next', 'next step'],
      de: ['weiter', 'nächster schritt'],
      fr: ['suivant', 'étape suivante'],
      ar: ['التالي'],
    },
  },
  {
    name: 'wizard_back', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Move the analysis wizard to the previous step', params: {},
    synonyms: {
      tr: ['geri', 'onceki adim', 'önceki adım'],
      en: ['back', 'previous step'],
      de: ['zuruck', 'zurück'],
      fr: ['précédent', 'étape précédente'],
      ar: ['رجوع', 'السابق'],
    },
  },
  {
    name: 'wizard_goto_step', navMatch: false, validOn: [SCREENS.DASHBOARD_ANALYSIS],
    description: 'Jump the analysis wizard directly to a numbered step (1-5)', params: { step: 'enum: 1|2|3|4|5' },
    synonyms: {
      tr: ['3. adıma git', 'adım 2'],
      en: ['go to step 3', 'step 2'],
      de: ['schritt 3', 'gehe zu schritt 2'],
      fr: ['étape 3', 'aller à l\'étape 2'],
      ar: ['خطوة 3'],
    },
  },

  // ── Settings ───────────────────────────────────────────────────────────
  {
    name: 'open_settings', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the settings panel', params: {},
    synonyms: {
      tr: ['ayarlara git', 'ayarlari ac', 'ayarları aç', 'ayarlar'],
      en: ['go to settings', 'open settings', 'settings'],
      de: ['einstellungen offnen', 'einstellungen öffnen', 'zu den einstellungen'],
      fr: ['ouvrir les parametres', 'ouvrir les paramètres', 'aller aux parametres'],
      ar: ['اذهب إلى الإعدادات', 'فتح الإعدادات'],
    },
  },
  {
    name: 'close_settings', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the settings panel', params: {},
    synonyms: {
      tr: ['ayarlari kapat', 'ayarları kapat'],
      en: ['close settings'],
      de: ['einstellungen schliessen', 'einstellungen schließen'],
      fr: ['fermer les parametres', 'fermer les paramètres'],
      ar: ['أغلق الإعدادات'],
    },
  },
  {
    name: 'set_language', navMatch: false, validOn: ALL_DASHBOARD,
    description: `Switch the application UI language (${SUPPORTED_LANGS.join('|')})`, params: { value: `enum: ${SUPPORTED_LANGS.join('|')}` },
    synonyms: {
      tr: ['dili ingilizceye çevir', 'almanca yap'],
      en: ['switch to german', 'change language to french'],
      de: ['wechsle zu englisch'],
      fr: ['passer en anglais'],
      ar: ['غيّر اللغة إلى الإنجليزية'],
    },
  },
  {
    name: 'set_theme', navMatch: false, validOn: ALL_DASHBOARD,
    description: 'Switch the appearance theme (dark/light/system)', params: { value: 'enum: dark|light|system' },
    synonyms: {
      tr: ['koyu temaya geç', 'açık tema', 'sistem temasına al'],
      en: ['switch to dark mode', 'light mode'],
      de: ['dunkles design', 'helles design'],
      fr: ['mode sombre', 'mode clair'],
      ar: ['الوضع الداكن', 'الوضع الفاتح'],
    },
  },

  // ── Menu / info ────────────────────────────────────────────────────────
  {
    name: 'open_menu', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the main navigation menu (guide/about/mission/contact)', params: {},
    synonyms: {
      tr: ['menuyu ac', 'menüyü aç'],
      en: ['open menu'],
      de: ['menu offnen', 'menü öffnen'],
      fr: ['ouvrir le menu'],
      ar: ['افتح القائمة'],
    },
  },
  {
    name: 'close_menu', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the main navigation menu', params: {},
    synonyms: {
      tr: ['menuyu kapat', 'menüyü kapat'],
      en: ['close menu'],
      de: ['menu schliessen', 'menü schließen'],
      fr: ['fermer le menu'],
      ar: ['أغلق القائمة'],
    },
  },
  {
    name: 'open_about', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the "about us" info panel', params: {},
    synonyms: {
      tr: ['hakkimizda', 'hakkımızda'],
      en: ['about us'],
      de: ['uber uns', 'über uns'],
      fr: ['a propos', 'à propos'],
      ar: ['من نحن'],
    },
  },
  {
    name: 'open_mission', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the "mission & vision" info panel', params: {},
    synonyms: {
      tr: ['misyon ve vizyon', 'misyonumuz'],
      en: ['mission and vision'],
      de: ['mission und vision'],
      fr: ['mission et vision'],
      ar: ['الرسالة والرؤية'],
    },
  },
  {
    name: 'open_contact', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the "contact" info panel', params: {},
    synonyms: {
      tr: ['iletisim', 'iletişim'],
      en: ['contact us'],
      de: ['kontakt'],
      fr: ['contact'],
      ar: ['اتصل بنا'],
    },
  },
  {
    name: 'close_info', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close whichever info panel (about/mission/contact) is open', params: {},
    synonyms: {
      tr: ['bilgi panelini kapat'],
      en: ['close info panel'],
      de: ['infofenster schliessen', 'infofenster schließen'],
      fr: ["fermer le panneau d'informations"],
      ar: ['أغلق لوحة المعلومات'],
    },
  },

  // ── Notifications ─────────────────────────────────────────────────────
  {
    name: 'open_notifications', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Open the notification center', params: {},
    synonyms: {
      tr: ['bildirimleri ac', 'bildirimleri aç', 'bildirim merkezi'],
      en: ['open notifications', 'notification center'],
      de: ['benachrichtigungen offnen', 'benachrichtigungen öffnen'],
      fr: ['ouvrir les notifications'],
      ar: ['افتح الإشعارات'],
    },
  },
  {
    name: 'close_notifications', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Close the notification center', params: {},
    synonyms: {
      tr: ['bildirimleri kapat'],
      en: ['close notifications'],
      de: ['benachrichtigungen schliessen', 'benachrichtigungen schließen'],
      fr: ['fermer les notifications'],
      ar: ['أغلق الإشعارات'],
    },
  },

  // ── Sidebar ────────────────────────────────────────────────────────────
  {
    name: 'expand_sidebar', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Expand the category sidebar', params: {},
    synonyms: {
      tr: ['kenar cubugunu ac', 'kenar çubuğunu aç', 'menuyu genislet', 'menüyü genişlet'],
      en: ['expand sidebar'],
      de: ['seitenleiste ausklappen'],
      fr: ['développer la barre latérale'],
      ar: ['وسّع الشريط الجانبي'],
    },
  },
  {
    name: 'collapse_sidebar', navMatch: true, validOn: ALL_DASHBOARD,
    description: 'Collapse the category sidebar', params: {},
    synonyms: {
      tr: ['kenar cubugunu daralt', 'kenar çubuğunu daralt'],
      en: ['collapse sidebar'],
      de: ['seitenleiste einklappen'],
      fr: ['réduire la barre latérale'],
      ar: ['اطوِ الشريط الجانبي'],
    },
  },

  // ── Admin: user management (RBAC-gated) ───────────────────────────────
  {
    name: 'open_user_management', navMatch: true, validOn: ALL_DASHBOARD, requiredPermission: 'admin',
    description: 'Open the user management panel (admin only)', params: {},
    synonyms: {
      tr: ['kullanici yonetimi', 'kullanıcı yönetimi', 'kullanicilari ac', 'kullanıcıları aç'],
      en: ['user management', 'manage users'],
      de: ['benutzerverwaltung'],
      fr: ['gestion des utilisateurs'],
      ar: ['إدارة المستخدمين'],
    },
  },
  {
    name: 'close_user_management', navMatch: true, validOn: ALL_DASHBOARD, requiredPermission: 'admin',
    description: 'Close the user management panel (admin only)', params: {},
    synonyms: {
      tr: ['kullanici yonetimini kapat', 'kullanıcı yönetimini kapat'],
      en: ['close user management'],
      de: ['benutzerverwaltung schliessen', 'benutzerverwaltung schließen'],
      fr: ['fermer la gestion des utilisateurs'],
      ar: ['أغلق إدارة المستخدمين'],
    },
  },

  // ── Admin: personnel radar (RBAC-gated, handlers self-registered by
  // PersonnelRadar.jsx -- this entry documents it for the coverage
  // check/UI_CATALOG rather than duplicating a second copy of its logic) ──
  {
    name: 'open_radar', navMatch: true, validOn: ALL_DASHBOARD, requiredPermission: 'admin',
    description: 'Open the personnel radar (admin only)', params: {},
    synonyms: {
      tr: ['personel radari', 'personel radarı', 'radari ac', 'radarı aç'],
      en: ['personnel radar', 'open radar'],
      de: ['personal-radar'],
      fr: ['radar du personnel'],
      ar: ['رادار الأفراد'],
    },
  },
  {
    name: 'close_radar', navMatch: true, validOn: ALL_DASHBOARD, requiredPermission: 'admin',
    description: 'Close the personnel radar (admin only)', params: {},
    synonyms: {
      tr: ['radari kapat', 'radarı kapat'],
      en: ['close radar'],
      de: ['radar schliessen', 'radar schließen'],
      fr: ['fermer le radar'],
      ar: ['أغلق الرادار'],
    },
  },

  // ── Home / daily briefing (handlers self-registered by HomeView.jsx) ──
  {
    name: 'open_briefing', navMatch: true, validOn: [SCREENS.DASHBOARD_HOME],
    description: 'Open the daily briefing modal (home view)', params: {},
    synonyms: {
      tr: ['gunluk brifingi ac', 'günlük brifingi aç', 'brifingi ac', 'brifingi aç'],
      en: ['open daily briefing', 'open briefing'],
      de: ['tagesbriefing offnen', 'tagesbriefing öffnen'],
      fr: ['ouvrir le briefing quotidien'],
      ar: ['افتح الإحاطة اليومية'],
    },
  },
  {
    name: 'close_briefing', navMatch: true, validOn: [SCREENS.DASHBOARD_HOME],
    description: 'Close the daily briefing modal', params: {},
    synonyms: {
      tr: ['brifingi kapat'],
      en: ['close briefing'],
      de: ['briefing schliessen', 'briefing schließen'],
      fr: ['fermer le briefing'],
      ar: ['أغلق الإحاطة'],
    },
  },
  {
    name: 'refresh_briefing', navMatch: true, validOn: [SCREENS.DASHBOARD_HOME], requiredPermission: 'admin',
    description: 'Refresh the daily briefing data sources (admin only)', params: {},
    synonyms: {
      tr: ['brifingi yenile', 'kaynaklari yenile', 'kaynakları yenile'],
      en: ['refresh briefing', 'refresh data sources'],
      de: ['briefing aktualisieren'],
      fr: ['actualiser le briefing'],
      ar: ['حدّث الإحاطة'],
    },
  },
];

export function catalogEntry(name) {
  return ACTION_CATALOG.find((e) => e.name === name) || null;
}
