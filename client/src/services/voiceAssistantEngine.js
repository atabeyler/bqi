import { getActionsForAI } from './voiceActionRegistry.js';
import { t as translate } from './i18n.js';
import {
  matchCategory, matchDepth, matchQuantum, mentionsAnalysis, mentionsStartVerb,
  mentionsNext, mentionsBack, mentionsReset, matchConfirm, matchCancel,
  matchPriority, mentionsDownload, mentionsPdf, mentionsShare,
  matchLanguageTarget, matchThemeTarget, matchWizardStepNumber,
  validateActionPlan, CONFIRM_REQUIRED_ACTIONS,
} from './voiceIntentSchema.js';
import { matchUiCatalogAction } from './voiceUiCatalog.js';

// ─── Local, fully offline command interpretation ──────────────────────────
// Everything in this module resolves a transcript to a validated action
// plan synchronously against local synonym tables and catalogs (see
// voiceIntentSchema.js / voiceUiCatalog.js) -- there is no network call and
// no AI/LLM involved in understanding or routing a voice command. The
// backend AI (server/src/routes/voice.js's /intent endpoint, backed by
// parseVoiceIntent in aiGenerate.ts) is no longer called from here; it is
// retained server-side, unused, as the lower-risk option over deleting a
// route/service function nothing else has been found to depend on -- see
// the comment on that route for details.
//
// Compositional design: action verbs, categories, analysis depth and the
// quantum toggle are resolved as independent slot-fillers (matchCategory,
// matchDepth, matchQuantum, mentionsNext/Back/Reset, matchUiCatalogAction,
// ...), then combined into one action or a short ordered plan. Adding a new
// synonym or a new navigable screen/button means adding a catalog entry in
// voiceIntentSchema.js / voiceUiCatalog.js, not new branching logic here.

// Spoken confirmations for the last-resort local fallback below (login page
// flows, and the final "I didn't understand" message) -- these stay in all
// 5 supported languages since they're reached regardless of which language
// the user is speaking.
const FALLBACK_TEXT = {
  tr: { loggingIn: 'Giriş yapılıyor.', formCleared: 'Form temizlendi.', userCodeEntered: (v) => `Kullanıcı kodu ${v} girildi.`, sayCode: 'Kullanıcı kodunuzu söyleyin, şifrenizi klavyeden girin, ya da "giriş yap" deyin.', home: 'Ana ekrana dönüldü.', analysis: 'Analiz ekranına geçiliyor.', history: 'Geçmiş açılıyor.', voiceChat: 'Sesli danışma açılıyor.', loggingOut: 'Çıkış yapılıyor.', notUnderstood: 'Anlayamadım, tekrar söyler misiniz?' },
  en: { loggingIn: 'Logging in.', formCleared: 'Form cleared.', userCodeEntered: (v) => `User code ${v} entered.`, sayCode: 'Say your user code, type your password, or say "login".', home: 'Returning home.', analysis: 'Opening analysis.', history: 'Opening history.', voiceChat: 'Opening voice chat.', loggingOut: 'Logging out.', notUnderstood: 'Could not understand, please repeat.' },
  de: { loggingIn: 'Anmeldung läuft.', formCleared: 'Formular geleert.', userCodeEntered: (v) => `Benutzercode ${v} eingegeben.`, sayCode: 'Nennen Sie Ihren Benutzercode, geben Sie Ihr Passwort über die Tastatur ein, oder sagen Sie „anmelden".', home: 'Zurück zur Startseite.', analysis: 'Analyse wird geöffnet.', history: 'Verlauf wird geöffnet.', voiceChat: 'Sprachberatung wird geöffnet.', loggingOut: 'Abmeldung läuft.', notUnderstood: 'Ich habe das nicht verstanden, bitte wiederholen Sie es.' },
  fr: { loggingIn: 'Connexion en cours.', formCleared: 'Formulaire effacé.', userCodeEntered: (v) => `Code utilisateur ${v} saisi.`, sayCode: 'Dites votre code utilisateur, saisissez votre mot de passe au clavier, ou dites « connexion ».', home: 'Retour à l\'accueil.', analysis: 'Ouverture de l\'analyse.', history: 'Ouverture de l\'historique.', voiceChat: 'Ouverture de la consultation vocale.', loggingOut: 'Déconnexion en cours.', notUnderstood: 'Je n\'ai pas compris, pouvez-vous répéter ?' },
  ar: { loggingIn: 'جارٍ تسجيل الدخول.', formCleared: 'تم مسح النموذج.', userCodeEntered: (v) => `تم إدخال رمز المستخدم ${v}.`, sayCode: 'قل رمز المستخدم، وأدخل كلمة المرور من لوحة المفاتيح، أو قل "تسجيل الدخول".', home: 'العودة إلى الرئيسية.', analysis: 'جارٍ فتح التحليل.', history: 'جارٍ فتح السجل.', voiceChat: 'جارٍ فتح الاستشارة الصوتية.', loggingOut: 'جارٍ تسجيل الخروج.', notUnderstood: 'لم أفهم، هل يمكنك التكرار؟' },
};

// ─── Pending voice confirmation (logout, and any future destructive action
// in CONFIRM_REQUIRED_ACTIONS) ──────────────────────────────────────────
// A tiny piece of module-level state bridging two consecutive utterances:
// "çıkış yap" asks "emin misiniz?" instead of executing immediately; only
// an explicit CONFIRM_WORDS reply on the *next* command actually runs the
// action. Any other utterance (including CANCEL_WORDS) drops the pending
// action and falls through to normal resolution of that new utterance.
let pendingConfirm = null; // { action, params, expiresAt }
const CONFIRM_TTL_MS = 20000;

/** Test-only: clears any pending confirmation between test cases. */
export function _resetVoiceEngineState() {
  pendingConfirm = null;
}

function speakFor(lang, key, vars) {
  return translate(lang, key, vars);
}

// ─── Local fallback ──────────────────────────────────────────────────────
// Last resort: login-page field filling (no dashboard actions registered
// there yet) and the final "I didn't understand" message. Dashboard
// navigation is handled earlier, catalog-driven, by resolveLocalIntent.
function localFallback(transcript, context) {
  const t = (transcript || '')
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');

  const T = FALLBACK_TEXT[context.lang] || FALLBACK_TEXT.tr;
  const say = (key, ...args) => (typeof T[key] === 'function' ? T[key](...args) : T[key]);

  if (context.page === 'login') {
    if (t.match(/giris\s*yap|login|onayla|gonder|devam|tamam|evet|confirm|submit/))
      return { actions: [{ action: 'submit_login', params: {} }], speak: say('loggingIn') };

    if (t.match(/temizle|sifirla|clear|sil|reset/))
      return { actions: [{ action: 'clear_login_form', params: {} }], speak: say('formCleared') };

    // Passwords are deliberately never accepted through the voice pipeline
    // (see LoginPage.jsx's registerActions comment) -- transcribed speech
    // passes through the same STT/logging path as any other voice command,
    // which is not a place a credential should ever travel through.
    const codeM = t.match(/(?:kullanici\s*(?:kod[u]?)?|kod[u]?|code|kimlik|id)\s*[:=]?\s*([a-z0-9]{2,20})/);
    if (codeM) {
      const val = codeM[1].toUpperCase();
      return { actions: [{ action: 'fill_username', params: { value: val } }], speak: say('userCodeEntered', val) };
    }
    const onlyDigits = t.match(/^\s*(\d{4,10})\s*$/);
    if (onlyDigits) {
      const val = onlyDigits[1];
      return { actions: [{ action: 'fill_username', params: { value: val } }], speak: say('userCodeEntered', val) };
    }
    return { actions: [], speak: say('sayCode') };
  }

  return { actions: [], speak: say('notUnderstood') };
}

// ─── Compositional local intent resolver ──────────────────────────────────
// Resolves category/depth/quantum/verb/navigation as independent slots and
// composes them into one action or a short ordered plan. Returns null when
// nothing here recognizes the utterance, so the caller falls through to
// localFallback. context: { page, category, depth, quantum, wizardStep,
// wizardOpen, lang, user } -- category/depth/quantum/wizard* come from the
// live aq:context broadcast (DashboardPage.jsx/AnalysisView.jsx), merged by
// GlobalVoiceAssistant.jsx, and represent "what's on screen right now".
function resolveLocalIntent(transcript, context, knownActionNames) {
  const raw = transcript || '';
  if (!raw.trim()) return null;
  const lang = context.lang || 'tr';

  // ── Pending confirmation gate (logout etc.) takes priority over
  // everything else -- the previous turn is still waiting on a yes/no.
  if (pendingConfirm) {
    const pending = pendingConfirm;
    const expired = Date.now() > pending.expiresAt;
    pendingConfirm = null;
    if (!expired) {
      if (matchConfirm(raw)) {
        return { actions: [{ action: pending.action, params: pending.params }], speak: speakFor(lang, 'voiceConfirmed') };
      }
      if (matchCancel(raw)) {
        return { actions: [], speak: speakFor(lang, 'voiceCancelled') };
      }
      // Anything else: drop the pending confirmation and fall through to
      // resolve this utterance as a normal new command below.
    }
  }

  if (!knownActionNames.has('start_analysis')) {
    // e.g. login page: dashboard actions aren't registered yet, so only
    // the login-focused localFallback below applies.
    return null;
  }

  const category = matchCategory(raw);
  const depth = matchDepth(raw);
  const quantum = matchQuantum(raw);
  const hasStartVerb = mentionsStartVerb(raw);
  const looksLikeAnalysisCommand = mentionsAnalysis(raw) || category;

  // ── A full "start a new analysis" command: category present (with or
  // without depth/quantum/analysis-word in the same utterance).
  if (category) {
    const params = { category };
    if (depth) params.depth = depth;
    if (quantum !== null) params.quantum = quantum;
    const categoryLabel = translate(lang, `cat_${category}`);
    return {
      actions: [{ action: 'start_analysis', params }],
      speak: translate(lang, 'voiceAnalysisCreatedNeedTopic', { category: categoryLabel }),
    };
  }

  // ── Analysis intent detected but no recognizable category -- ask,
  // never guess by clicking a random visible control.
  if (looksLikeAnalysisCommand) {
    return { actions: [], speak: translate(lang, 'voiceClarifyCategory') };
  }

  // ── Global app-preference commands (UI language / appearance theme) --
  // work from any authenticated screen, not just mid-wizard, since they
  // are not analysis-scoped state.
  const languageTarget = matchLanguageTarget(raw);
  if (languageTarget) {
    return { actions: [{ action: 'set_language', params: { value: languageTarget } }], speak: translate(languageTarget, 'voiceContextAck') };
  }
  const themeTarget = matchThemeTarget(raw);
  if (themeTarget) {
    return { actions: [{ action: 'set_theme', params: { value: themeTarget } }], speak: translate(lang, 'voiceContextAck') };
  }

  // ── Context-aware follow-ups: the user is on the analysis screen with a
  // wizard already open for a category -- "Derin yap", "Kuantumu aç",
  // "Sonraki", "Sıfırla", bare "Başlat" resolve against that live wizard
  // state without needing the category repeated. Also reachable once a
  // result is already on screen (wizardOpen has flipped false, but
  // hasResult is true) so "raporu indir"/"paylaş" work post-generation.
  if (context.page === 'dashboard-analysis' && context.category && (context.wizardOpen || context.hasResult)) {
    const steps = [];
    if (depth) steps.push({ action: 'set_analysis_depth', params: { value: depth } });
    if (quantum !== null) steps.push({ action: 'toggle_quantum', params: { mode: quantum ? 'on' : 'off' } });
    const priority = matchPriority(raw);
    if (priority) steps.push({ action: 'set_analysis_priority', params: { value: priority } });
    if (mentionsNext(raw)) steps.push({ action: 'wizard_next', params: {} });
    if (mentionsBack(raw)) steps.push({ action: 'wizard_back', params: {} });
    const stepNumber = matchWizardStepNumber(raw);
    if (stepNumber) steps.push({ action: 'wizard_goto_step', params: { step: stepNumber } });
    if (mentionsReset(raw)) steps.push({ action: 'reset_analysis', params: {} });
    if (mentionsShare(raw)) steps.push({ action: 'share_analysis', params: {} });
    if (mentionsDownload(raw)) steps.push({ action: mentionsPdf(raw) ? 'download_analysis_pdf' : 'download_analysis', params: {} });
    // A bare start verb ("Başlat") with no other slot matched means "run
    // the analysis with what's already configured" -- only when nothing
    // more specific (depth/quantum/priority/next/back/reset/download/share)
    // already claimed it, so "kuantumu aç" (which also contains the
    // generic verb "aç") doesn't also fire generate_analysis.
    if (steps.length === 0 && hasStartVerb) steps.push({ action: 'generate_analysis', params: {} });

    if (steps.length > 0) {
      return { actions: steps, speak: translate(lang, 'voiceContextAck') };
    }
  }

  // ── Navigation / panel catalog (works from any known dashboard screen).
  const uiMatch = matchUiCatalogAction(raw, context.page);
  if (uiMatch) {
    if (uiMatch.requiresConfirmation && CONFIRM_REQUIRED_ACTIONS.has(uiMatch.action)) {
      pendingConfirm = { action: uiMatch.action, params: {}, expiresAt: Date.now() + CONFIRM_TTL_MS };
      return { actions: [], speak: translate(lang, 'voiceConfirmLogout') };
    }
    return { actions: [{ action: uiMatch.action, params: {} }], speak: speakForUiMatch(lang, uiMatch) };
  }

  return null;
}

function speakForUiMatch(lang, entry) {
  const key = {
    navigate_home: 'home', navigate_analysis: 'analysis', navigate_history: 'history', open_voice_chat: 'voiceChat',
  }[entry.action];
  if (key) return (FALLBACK_TEXT[lang] || FALLBACK_TEXT.tr)[key];
  return translate(lang, 'voiceContextAck');
}

// ─── Main function ───────────────────────────────────────────────────────
/**
 * Process the voice command; returns the actions to run and the speech
 * text. Fully local and synchronous-feeling: transcript -> compositional
 * slot resolution (category/depth/quantum/verb/navigation, see
 * resolveLocalIntent) -> schema validation (voiceIntentSchema.js) ->
 * returned actions. No network call, no AI/LLM in this path.
 *
 * context: { page, category, depth, quantum, wizardStep, wizardOpen,
 * lang: 'tr'|'en'|'de'|'fr'|'ar', user: string|null }
 * Returns: { actions: [{action, params}], speak: string }
 */
export async function processVoiceCommand(transcript, context) {
  const actions = getActionsForAI();
  const knownActionNames = new Set(actions.map((a) => a.name));
  const lang = context.lang || 'tr';

  const local = resolveLocalIntent(transcript, context, knownActionNames);
  if (local) {
    const { valid, rejected } = validateActionPlan(local.actions, knownActionNames, transcript);
    if (valid.length || local.actions.length === 0) {
      return { actions: valid, speak: local.speak };
    }
    // The local resolver proposed something invalid (should not normally
    // happen, it only ever builds schema-shaped actions) -- fail safely
    // into a clarification rather than executing a rejected action.
    return { actions: [], speak: rejected[0]?.reason ? translate(lang, 'voiceInvalidCommand') : local.speak };
  }

  return localFallback(transcript, context);
}
