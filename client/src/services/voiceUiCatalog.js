// Thin phrase-matching layer over the canonical voiceActionCatalog.js.
// UI_CATALOG here is *derived* (not hand-duplicated) from every
// ACTION_CATALOG entry marked `navMatch: true` -- the entries reachable by
// a fixed navigation phrase from anywhere on their `validOn` screens. This
// is what lets the voice engine resolve navigation commands ("panele git",
// "ayarlara git", "geçmiş") deterministically against the app's actual
// page/panel model instead of falling back to ui_activate's fuzzy DOM
// label search. Adding a new page/panel/button means adding one entry to
// ACTION_CATALOG in voiceActionCatalog.js -- not new matching code, and
// not a second synonym list here.
//
// SCREENS mirrors the `page` values the app actually broadcasts on the
// `aq:context` window event (see DashboardPage.jsx/AnalysisView.jsx
// dispatching it, and GlobalVoiceAssistant.jsx consuming it) -- there is no
// separate invented navigation model here, just the real one, named.
import { foldText } from './voiceIntentSchema.js';
import { ACTION_CATALOG, SCREENS } from './voiceActionCatalog.js';

export { SCREENS };

export const UI_CATALOG = ACTION_CATALOG.filter((entry) => entry.navMatch).map((entry) => ({
  id: entry.name,
  action: entry.name,
  validOn: entry.validOn,
  synonyms: entry.synonyms,
  requiresConfirmation: entry.requiresConfirmation,
  requiredPermission: entry.requiredPermission,
}));

/**
 * Finds the UI_CATALOG entry whose synonyms best match `text` (longest
 * matching phrase wins, e.g. "ayarları kapat" -> close_settings rather than
 * the shorter, more generic "ayarlar" -> open_settings), restricted to
 * entries whose validOn list includes the current screen (or any screen,
 * when the current screen is unknown/not yet reported). Returns the whole
 * catalog entry (so callers can read requiresConfirmation etc.), or null.
 * Picking the longest match (rather than the first array match) is what
 * keeps every open_X/close_X pair correctly disambiguated regardless of
 * which one happens to be declared first in ACTION_CATALOG.
 */
export function matchUiCatalogAction(text, currentScreen) {
  const t = foldText(text);
  const screenKnown = currentScreen && currentScreen !== 'unknown';
  let best = null;
  let bestLen = -1;
  for (const entry of UI_CATALOG) {
    if (screenKnown && entry.validOn && !entry.validOn.includes(currentScreen)) continue;
    const bag = entry.synonyms || {};
    for (const words of Object.values(bag)) {
      for (const w of words) {
        const folded = foldText(w);
        if (folded.length > bestLen && t.includes(folded)) {
          best = entry;
          bestLen = folded.length;
        }
      }
    }
  }
  return best;
}
