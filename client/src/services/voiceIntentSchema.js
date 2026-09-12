// Single source of truth for the voice assistant's typed intent/action
// schema: the real analysis categories, real analysis depths, and the
// per-action parameter shapes every resolved action (local OR AI-backed)
// must validate against before it is ever executed. Nothing --  not the
// local deterministic resolver, not the AI response -- reaches
// voiceActionRegistry.executeAction without going through this module
// first. That is what stops the assistant from clicking a semi-random DOM
// control for a critical intent it merely guessed at.
import { CATEGORIES } from '../components/CategorySidebar.jsx';
import { SUPPORTED_LANGS } from './i18n.js';

// ─── Real, app-derived enums ──────────────────────────────────────────────
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const DEPTH_IDS = ['hizli', 'standart', 'derin'];
export const QUANTUM_MODES = ['on', 'off'];

// Actions that must never be satisfied by the generic ui_activate DOM
// fallback -- if the AI (or a local match) resolves one of these to
// ui_activate, it is rejected and the assistant asks for clarification
// instead of clicking whatever the fuzzy label-matcher happens to find.
export const CRITICAL_ACTIONS = new Set([
  'start_analysis',
  'navigate_analysis',
  'navigate_home',
  'navigate_history',
  'new_analysis',
  'toggle_quantum',
  'generate_analysis',
  'set_analysis_title',
  'set_analysis_prompt',
  'set_analysis_depth',
  'set_analysis_priority',
  'wizard_next',
  'wizard_back',
  'wizard_goto_step',
  'open_settings',
  'close_settings',
  'logout',
  'open_user_management',
  'close_user_management',
]);

// Actions that must never execute straight off a voice match -- the engine
// asks a yes/no confirmation question first and only runs the action once
// the following utterance matches CONFIRM_WORDS (see
// voiceAssistantEngine.js's pending-confirmation gate). Kept as its own set
// (distinct from CRITICAL_ACTIONS, which is about routing safety, not
// destructiveness) so new destructive actions can opt in without changing
// the routing rules above.
export const CONFIRM_REQUIRED_ACTIONS = new Set(['logout']);

// ─── Multilingual synonym tables (TR/EN/DE/FR/AR) ─────────────────────────
// Used by the local deterministic resolver AND to repair/validate a
// category or depth value the AI answers with in natural language instead
// of the app's internal id (e.g. "energy" -> "enerji").
export const CATEGORY_SYNONYMS = {
  savunma:      { tr: ['savunma'], en: ['defense', 'defence'], de: ['verteidigung'], fr: ['défense', 'defense'], ar: ['دفاع'] },
  enerji:       { tr: ['enerji'], en: ['energy'], de: ['energie'], fr: ['énergie', 'energie'], ar: ['طاقة'] },
  saldiri:      { tr: ['saldırı', 'saldiri'], en: ['attack', 'offensive'], de: ['angriff'], fr: ['attaque'], ar: ['هجوم'] },
  ekonomi:      { tr: ['ekonomi'], en: ['economy', 'economic'], de: ['wirtschaft'], fr: ['économie', 'economie'], ar: ['اقتصاد'] },
  toplumsal:    { tr: ['toplumsal', 'sosyal'], en: ['social', 'societal'], de: ['gesellschaft', 'sozial'], fr: ['social', 'société'], ar: ['اجتماعي'] },
  danisma:      { tr: ['danışma', 'danisma'], en: ['advisory', 'consultation', 'consult'], de: ['beratung'], fr: ['consultation'], ar: ['استشارة'] },
  saglik:       { tr: ['sağlık', 'saglik'], en: ['health'], de: ['gesundheit'], fr: ['santé', 'sante'], ar: ['صحة'] },
  'cok-alanli': { tr: ['çok alanlı', 'cok alanli', 'çoklu alan', 'coklu alan'], en: ['multi-domain', 'multi domain', 'cross-domain'], de: ['multidomäne', 'bereichsübergreifend'], fr: ['multi-domaine', 'multidomaine'], ar: ['متعدد المجالات'] },
  bddk:         { tr: ['bddk', 'bankacılık', 'bankacilik'], en: ['bddk', 'banking'], de: ['bddk', 'bankwesen'], fr: ['bddk', 'bancaire'], ar: ['bddk', 'مصرفي'] },
  btk:          { tr: ['btk', 'haberleşme', 'haberlesme', 'telekom'], en: ['btk', 'telecom'], de: ['btk', 'telekom'], fr: ['btk', 'télécom'], ar: ['btk', 'اتصالات'] },
  siber:        { tr: ['siber', 'siber güvenlik', 'siber guvenlik', 'siber istihbarat'], en: ['cyber', 'cybersecurity', 'cyber intelligence'], de: ['cyber', 'cybersicherheit'], fr: ['cyber', 'cybersécurité', 'cybersecurite'], ar: ['سيبراني', 'الأمن السيبراني'] },
};

export const DEPTH_SYNONYMS = {
  hizli:    { tr: ['hızlı', 'hizli', 'kısa'], en: ['fast', 'quick'], de: ['schnell'], fr: ['rapide'], ar: ['سريع'] },
  standart: { tr: ['standart', 'normal'], en: ['standard', 'normal'], de: ['standard'], fr: ['standard'], ar: ['قياسي'] },
  derin:    { tr: ['derin', 'detaylı', 'detayli', 'ayrıntılı', 'ayrintili'], en: ['deep', 'detailed', 'thorough'], de: ['tief', 'ausführlich'], fr: ['approfondi', 'détaillé', 'detaille'], ar: ['عميق', 'مفصل'] },
};

const QUANTUM_ON_WORDS = ['kuantum destek', 'kuantumu etkinlestir', 'kuantumu ac', 'kuantum modunu ac', 'kuantum ile', 'kuantum destekli', 'quantum enabled', 'with quantum', 'enable quantum', 'quantum aktiviert', 'quantique activé', 'quantique active', 'كمي مفعل'];
const QUANTUM_OFF_WORDS = ['kuantumu kapat', 'kuantumu kaldir', 'kuantumu kaldır', 'kuantum olmadan', 'without quantum', 'disable quantum', 'quantum off', 'quantum deaktiviert', 'sans quantique', 'بدون كمي'];
const QUANTUM_WORD = ['kuantum', 'quantum', 'quanten', 'quantique', 'كمي'];
const NEGATION_WORD = ['kapat', 'kaldir', 'kaldır', 'olmadan', 'disable', 'off', 'without', 'aus', 'deaktiv', 'sans', 'désactiv', 'بدون', 'إيقاف'];

const ANALYSIS_WORDS = ['analiz', 'analysis', 'analyse', 'تحليل'];
const START_VERB_WORDS = ['baslat', 'başlat', 'olustur', 'oluştur', 'yap', 'ac', 'aç', 'start', 'create', 'run', 'begin', 'launch', 'starten', 'erstellen', 'démarrer', 'lancer', 'créer', 'ابدأ', 'أنشئ'];

// ─── Context/navigation slot words (multilingual) ─────────────────────────
// Independent slot-fillers for the compositional context-aware commands a
// user issues while already on the analysis screen (e.g. "Derin yap",
// "Sonraki", "Sıfırla") -- see voiceAssistantEngine.js's resolveLocalIntent,
// which combines these with matchCategory/matchDepth/matchQuantum instead
// of hardcoding whole sentences.
const NEXT_WORDS = ['sonraki', 'ileri', 'devam', 'next', 'next step', 'forward', 'weiter', 'nächster schritt', 'suivant', 'étape suivante', 'التالي'];
const BACK_WORDS = ['geri don', 'geri dön', 'geri', 'onceki adim', 'önceki adım', 'back', 'go back', 'previous step', 'zuruck', 'zurück', 'précédent', 'étape précédente', 'رجوع', 'السابق'];
const RESET_WORDS = ['sifirla', 'sıfırla', 'temizle', 'reset', 'clear', 'zurucksetzen', 'zurücksetzen', 'reinitialiser', 'réinitialiser', 'اعادة تعيين', 'إعادة تعيين'];
const NEW_WORDS = ['yeni', 'new', 'neu', 'nouvelle', 'nouveau', 'جديد'];
export const CONFIRM_WORDS = ['evet', 'onayliyorum', 'onaylıyorum', 'tamam', 'devam et', 'onayla', 'yes', 'confirm', 'proceed', 'ok', 'okay', 'ja', 'bestatigen', 'bestätigen', 'oui', 'confirmer', 'نعم', 'أؤكد'];
export const CANCEL_WORDS = ['hayir', 'hayır', 'iptal', 'vazgec', 'vazgeç', 'no', 'cancel', 'nein', 'abbrechen', 'non', 'annuler', 'لا', 'إلغاء'];

// ─── Analysis priority slot (wizard step 1 field, previously unreachable
// by voice) -- independent slot-filler, same pattern as DEPTH_SYNONYMS.
export const PRIORITY_IDS = ['dusuk', 'normal', 'yuksek', 'kritik'];
const PRIORITY_SYNONYMS = {
  dusuk:   { tr: ['düşük öncelik', 'dusuk oncelik', 'öncelik düşük', 'oncelik dusuk', 'düşük'], en: ['low priority', 'priority low', 'priority to low'], de: ['niedrige priorität', 'niedrige prioritat'], fr: ['priorité basse', 'priorite basse'], ar: ['أولوية منخفضة'] },
  normal:  { tr: ['normal öncelik', 'normal oncelik', 'öncelik normal', 'oncelik normal'], en: ['normal priority', 'priority normal', 'priority to normal'], de: ['normale priorität', 'normale prioritat'], fr: ['priorité normale', 'priorite normale'], ar: ['أولوية عادية'] },
  yuksek:  { tr: ['yüksek öncelik', 'yuksek oncelik', 'öncelik yüksek', 'oncelik yuksek', 'yüksek'], en: ['high priority', 'priority high', 'priority to high'], de: ['hohe priorität', 'hohe prioritat'], fr: ['priorité élevée', 'priorite elevee', 'priorité haute'], ar: ['أولوية عالية'] },
  kritik:  { tr: ['kritik öncelik', 'kritik oncelik', 'öncelik kritik', 'oncelik kritik'], en: ['critical priority', 'priority critical', 'priority to critical'], de: ['kritische priorität', 'kritische prioritat'], fr: ['priorité critique', 'priorite critique'], ar: ['أولوية حرجة'] },
};

// ─── Report download/share slot words (multilingual) -- previously
// registered (download_analysis) but never reachable from any spoken
// phrase once a result was on screen (see voiceAssistantEngine.js).
const DOWNLOAD_WORDS = ['indir', 'download', 'herunterladen', 'télécharger', 'telecharger', 'تنزيل', 'نزل'];
const SHARE_WORDS = ['paylas', 'paylaş', 'share', 'teilen', 'partager', 'مشاركة', 'شارك'];
const PDF_WORD = ['pdf'];

// ─── Global app-preference slots: UI language and appearance theme -- work
// from anywhere, not just the analysis wizard (see resolveLocalIntent).
const LANGUAGE_TARGETS = {
  en: { tr: ['ingilizce'], en: ['english'], de: ['englisch'], fr: ['anglais'], ar: ['إنجليزي', 'الإنجليزية'] },
  tr: { tr: ['türkçe', 'turkce'], en: ['turkish'], de: ['türkisch', 'turkisch'], fr: ['turc'], ar: ['تركي', 'التركية'] },
  de: { tr: ['almanca'], en: ['german'], de: ['deutsch'], fr: ['allemand'], ar: ['ألماني', 'الألمانية'] },
  fr: { tr: ['fransızca', 'fransizca'], en: ['french'], de: ['französisch', 'franzosisch'], fr: ['français', 'francais'], ar: ['فرنسي', 'الفرنسية'] },
  ar: { tr: ['arapça', 'arapca'], en: ['arabic'], de: ['arabisch'], fr: ['arabe'], ar: ['عربي', 'العربية'] },
};
const THEME_TARGETS = {
  dark:   { tr: ['koyu tema', 'karanlık tema', 'karanlik tema', 'koyu mod'], en: ['dark mode', 'dark theme'], de: ['dunkles design', 'dunkelmodus'], fr: ['mode sombre', 'theme sombre', 'thème sombre'], ar: ['الوضع الداكن', 'السمة الداكنة'] },
  light:  { tr: ['açık tema', 'acik tema', 'aydınlık tema', 'açık mod'], en: ['light mode', 'light theme'], de: ['helles design', 'hellmodus'], fr: ['mode clair', 'theme clair', 'thème clair'], ar: ['الوضع الفاتح', 'السمة الفاتحة'] },
  system: { tr: ['sistem teması', 'sistem temasi', 'sistem moduna al'], en: ['system theme', 'system mode'], de: ['systemdesign', 'systemmodus'], fr: ['theme systeme', 'thème système', 'mode systeme'], ar: ['سمة النظام'] },
};

// ─── Wizard step-number slot ("3. adıma git" / "step 2" / "schritt 3") --
// language-agnostic on the digit so it works uniformly across all 5
// languages without needing ordinal-word tables for each one.
const STEP_WORD = ['adim', 'adım', 'step', 'schritt', 'etape', 'étape', 'خطوة'];

// ─── Text folding ──────────────────────────────────────────────────────────
// Lowercases and strips Turkish/French/German diacritics for loose matching
// while leaving non-Latin scripts (Arabic) untouched -- unlike
// voiceIntentRouter.normalizeText this never strips non a-z0-9 characters,
// so Arabic synonyms still match.
export function foldText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıİ]/g, 'i').replace(/[öÖ]/g, 'o').replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesWord(haystack, needle) {
  return haystack.includes(foldText(needle));
}

// ─── Synonym matchers ──────────────────────────────────────────────────────
export function matchCategory(text) {
  const t = foldText(text);
  for (const id of CATEGORY_IDS) {
    const bag = CATEGORY_SYNONYMS[id];
    if (!bag) continue;
    for (const words of Object.values(bag)) {
      for (const w of words) if (includesWord(t, w)) return id;
    }
  }
  return null;
}

export function matchDepth(text) {
  const t = foldText(text);
  for (const id of DEPTH_IDS) {
    const bag = DEPTH_SYNONYMS[id];
    if (!bag) continue;
    for (const words of Object.values(bag)) {
      for (const w of words) if (includesWord(t, w)) return id;
    }
  }
  return null;
}

/** Returns true/false when the utterance clearly mentions quantum mode, otherwise null (not mentioned). */
export function matchQuantum(text) {
  const t = foldText(text);
  if (QUANTUM_OFF_WORDS.some((w) => includesWord(t, w))) return false;
  if (QUANTUM_ON_WORDS.some((w) => includesWord(t, w))) return true;
  if (QUANTUM_WORD.some((w) => includesWord(t, w))) {
    return NEGATION_WORD.some((w) => includesWord(t, w)) ? false : true;
  }
  return null;
}

export function mentionsAnalysis(text) {
  const t = foldText(text);
  return ANALYSIS_WORDS.some((w) => includesWord(t, w));
}

export function mentionsStartVerb(text) {
  const t = foldText(text);
  return START_VERB_WORDS.some((w) => includesWord(t, w));
}

export function mentionsNext(text) { const t = foldText(text); return NEXT_WORDS.some((w) => includesWord(t, w)); }
export function mentionsBack(text) { const t = foldText(text); return BACK_WORDS.some((w) => includesWord(t, w)); }
export function mentionsReset(text) { const t = foldText(text); return RESET_WORDS.some((w) => includesWord(t, w)); }
export function mentionsNew(text) { const t = foldText(text); return NEW_WORDS.some((w) => includesWord(t, w)); }
export function matchConfirm(text) { const t = foldText(text); return CONFIRM_WORDS.some((w) => includesWord(t, w)); }
export function matchCancel(text) { const t = foldText(text); return CANCEL_WORDS.some((w) => includesWord(t, w)); }

export function matchPriority(text) {
  const t = foldText(text);
  for (const id of PRIORITY_IDS) {
    const bag = PRIORITY_SYNONYMS[id];
    if (!bag) continue;
    for (const words of Object.values(bag)) {
      for (const w of words) if (includesWord(t, w)) return id;
    }
  }
  return null;
}

export function mentionsDownload(text) { const t = foldText(text); return DOWNLOAD_WORDS.some((w) => includesWord(t, w)); }
export function mentionsPdf(text) { const t = foldText(text); return PDF_WORD.some((w) => includesWord(t, w)); }
export function mentionsShare(text) { const t = foldText(text); return SHARE_WORDS.some((w) => includesWord(t, w)); }

/** Returns the target language id (en|tr|de|fr|ar) a spoken command names, or null. */
export function matchLanguageTarget(text) {
  const t = foldText(text);
  for (const id of SUPPORTED_LANGS) {
    const bag = LANGUAGE_TARGETS[id];
    if (!bag) continue;
    for (const words of Object.values(bag)) {
      for (const w of words) if (includesWord(t, w)) return id;
    }
  }
  return null;
}

/** Returns the target theme mode (dark|light|system) a spoken command names, or null. */
export function matchThemeTarget(text) {
  const t = foldText(text);
  for (const id of Object.keys(THEME_TARGETS)) {
    const bag = THEME_TARGETS[id];
    for (const words of Object.values(bag)) {
      for (const w of words) if (includesWord(t, w)) return id;
    }
  }
  return null;
}

/** Returns a wizard step number (1-5) spoken alongside a step-word ("3. adıma git", "step 2"), or null. */
export function matchWizardStepNumber(text) {
  const t = foldText(text);
  if (!STEP_WORD.some((w) => includesWord(t, w))) return null;
  const m = t.match(/([1-5])/);
  return m ? m[1] : null;
}

// A critical-intent utterance is one whose meaning is unambiguous enough
// (mentions analysis/quantum by name) that the assistant must resolve it
// through a real semantic action -- never through ui_activate's fuzzy
// label search, even when the AI or local resolver otherwise can't fully
// parse it.
export function isCriticalIntentText(text) {
  const t = foldText(text);
  return mentionsAnalysis(t) || QUANTUM_WORD.some((w) => includesWord(t, w));
}

// ─── Param schema + validation ─────────────────────────────────────────────
export const ACTION_PARAM_SCHEMAS = {
  start_analysis: {
    category: { type: 'category', required: true },
    depth: { type: 'depth', required: false, default: 'standart' },
    quantum: { type: 'boolean', required: false, default: false },
    prompt: { type: 'string', required: false },
    title: { type: 'string', required: false },
  },
  navigate_analysis: {
    category: { type: 'category', required: false },
  },
  toggle_quantum: {
    mode: { type: 'enum', values: QUANTUM_MODES, required: false, default: 'on' },
  },
  set_analysis_title: {
    value: { type: 'string', required: false },
  },
  set_analysis_prompt: {
    value: { type: 'string', required: false },
  },
  set_analysis_depth: {
    value: { type: 'depth', required: true },
  },
  set_analysis_priority: {
    value: { type: 'enum', values: PRIORITY_IDS, required: true },
  },
  wizard_goto_step: {
    step: { type: 'enum', values: ['1', '2', '3', '4', '5'], required: true },
  },
  set_language: {
    value: { type: 'enum', values: SUPPORTED_LANGS, required: true },
  },
  set_theme: {
    value: { type: 'enum', values: ['dark', 'light', 'system'], required: true },
  },
};

function coerceBoolean(v) {
  if (typeof v === 'boolean') return v;
  const t = foldText(v);
  if (['true', 'on', 'yes', 'evet', '1', 'acik', 'açık'].includes(t)) return true;
  if (['false', 'off', 'no', 'hayir', 'hayır', '0', 'kapali', 'kapalı'].includes(t)) return false;
  return Boolean(v);
}

function matchEnumValue(paramName, type, raw, values) {
  if (raw === undefined || raw === null) return null;
  if (type === 'category') return CATEGORY_IDS.includes(raw) ? raw : matchCategory(String(raw));
  if (type === 'depth') return DEPTH_IDS.includes(raw) ? raw : matchDepth(String(raw));
  const folded = foldText(raw);
  return values.find((v) => foldText(v) === folded) || null;
}

/**
 * Validates & coerces the params object for one action name against
 * ACTION_PARAM_SCHEMAS. Actions with no declared schema (universal ui_*
 * actions, simple no-param semantic actions) pass their params through
 * unchanged -- this module only constrains the actions that actually carry
 * structured, enum-shaped parameters.
 * Returns { params, errors }. Non-empty errors means the action is invalid
 * and must not be executed.
 */
export function coerceAndValidateParams(actionName, rawParams = {}) {
  const schema = ACTION_PARAM_SCHEMAS[actionName];
  if (!schema) return { params: { ...(rawParams || {}) }, errors: [] };

  const out = {};
  const errors = [];
  for (const [key, def] of Object.entries(schema)) {
    const raw = rawParams?.[key];
    const isEmpty = raw === undefined || raw === null || raw === '';
    if (isEmpty) {
      if (def.required) errors.push(`missing required param "${key}" for ${actionName}`);
      else if (def.default !== undefined) out[key] = def.default;
      continue;
    }
    if (def.type === 'boolean') {
      out[key] = coerceBoolean(raw);
      continue;
    }
    if (def.type === 'string') {
      out[key] = String(raw);
      continue;
    }
    const matched = matchEnumValue(key, def.type, raw, def.values);
    if (!matched) {
      if (def.required) errors.push(`invalid value "${raw}" for "${key}" in ${actionName}`);
      else if (def.default !== undefined) out[key] = def.default;
      continue;
    }
    out[key] = matched;
  }
  return { params: out, errors };
}

/**
 * Validates one candidate {action, params} against the set of action names
 * the app actually has registered right now (knownActionNames, typically
 * getActionsForAI().map(a => a.name)) plus the param schema above. This is
 * the ONE place both the local resolver's output and the AI's parsed JSON
 * are required to pass through before anything executes.
 */
export function validateActionCandidate(candidate, knownActionNames, transcript = '') {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, error: 'malformed action entry' };
  }
  const name = candidate.action;
  if (!name || typeof name !== 'string') return { valid: false, error: 'missing action name' };
  if (knownActionNames && !knownActionNames.has(name)) return { valid: false, error: `unknown action: ${name}` };
  if (name === 'ui_activate' && isCriticalIntentText(transcript)) {
    return { valid: false, error: 'ui_activate refused for a critical (analysis/quantum) intent' };
  }
  const { params, errors } = coerceAndValidateParams(name, candidate.params && typeof candidate.params === 'object' ? candidate.params : {});
  if (errors.length) return { valid: false, error: errors.join('; ') };
  return { valid: true, action: name, params };
}

/**
 * Validates a whole action plan (array). Used for both the AI's parsed
 * response and any locally-built multi-step plan -- same rules either way.
 * Stops collecting further actions once a critical action fails validation,
 * since a plan built on an invalid critical step is not safe to continue.
 */
export function validateActionPlan(rawActions, knownActionNames, transcript = '') {
  const valid = [];
  const rejected = [];
  if (!Array.isArray(rawActions)) return { valid, rejected: [{ reason: 'actions is not an array' }] };

  for (const candidate of rawActions) {
    const result = validateActionCandidate(candidate, knownActionNames, transcript);
    if (result.valid) {
      valid.push({ action: result.action, params: result.params });
    } else {
      rejected.push({ candidate, reason: result.error });
      if (candidate?.action && CRITICAL_ACTIONS.has(candidate.action)) break;
    }
  }
  return { valid, rejected };
}
