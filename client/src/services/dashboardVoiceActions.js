// Builder for the semantic voice actions DashboardPage (and the components
// it renders directly) registers. Shared between DashboardPage.jsx and its
// coverage tests so the two cannot drift apart.
//
// Every action's description/params/RBAC metadata is looked up from
// voiceActionCatalog.js -- the single canonical registry of action
// metadata + multilingual synonyms (see that file) -- rather than being
// hand-typed a second time here. This file only supplies the `handler`:
// the actual closure over DashboardPage's state setters and dispatch.
import { catalogEntry } from './voiceActionCatalog.js';
import { setThemePersisted } from '../components/AppMenus.jsx';

// Builds one registry-shaped action ({ name, description, params, handler })
// by merging the canonical catalog entry's metadata with a caller-supplied
// handler. Throws loudly in dev if a name has no catalog entry -- that
// would mean an action exists here with no single-source-of-truth metadata,
// exactly the drift this refactor exists to prevent.
function withCatalog(name, handler) {
  const entry = catalogEntry(name);
  if (!entry) throw new Error(`[dashboardVoiceActions] "${name}" has no voiceActionCatalog.js entry`);
  return { name, description: entry.description, params: entry.params || {}, handler };
}

export function buildDashboardVoiceActions({
  setView,
  setActiveCategory,
  setHistoryOpen,
  setVoiceChatOpen,
  setGuideOpen,
  setJWT,
  disconnectSocket,
  onLogout,
  performLogout,
  dispatch,
  setPendingAnalysis = () => {},
  setSettingsOpen = () => {},
  setMenuOpen = () => {},
  setInfoPanel = () => {},
  setNotifOpen = () => {},
  setSidebarCollapsed = () => {},
  setUserMgmtOpen = () => {},
  setLang = () => {},
  isAdmin = false,
}) {
  const actions = [
    withCatalog('navigate_home', () => setView('home')),
    withCatalog('navigate_analysis', (p) => { setActiveCategory(p?.category || null); setView('analysis'); }),
    withCatalog('start_analysis', (p) => {
      setActiveCategory(p?.category || null);
      setView('analysis');
      setPendingAnalysis({ depth: p?.depth, quantum: p?.quantum, prompt: p?.prompt, title: p?.title });
    }),
    withCatalog('navigate_history', () => setHistoryOpen(true)),
    withCatalog('close_history', () => setHistoryOpen(false)),
    withCatalog('new_analysis', () => { setActiveCategory(null); setView('analysis'); }),
    withCatalog('open_voice_chat', () => setVoiceChatOpen(true)),
    withCatalog('close_voice_chat', () => setVoiceChatOpen(false)),
    withCatalog('open_guide', () => setGuideOpen(true)),
    withCatalog('close_guide', () => setGuideOpen(false)),
    // Prefers the page's own performLogout() (clears the native secure
    // store too, see DashboardPage.jsx's logout()) when supplied; falls
    // back to the bare setJWT(null)/disconnectSocket()/onLogout() sequence
    // only for a caller (e.g. an older test) that hasn't wired it up yet.
    withCatalog('logout', () => {
      if (performLogout) return performLogout();
      setJWT(null);
      disconnectSocket();
      onLogout();
    }),
    withCatalog('open_emergency', () => dispatch('aq:emergency:open', {})),
    withCatalog('set_analysis_title', (p) => dispatch('aq:analysis:set', { field: 'title', value: p?.value || '' })),
    withCatalog('set_analysis_prompt', (p) => dispatch('aq:analysis:set', { field: 'prompt', value: p?.value || '' })),
    withCatalog('generate_analysis', () => dispatch('aq:analysis:generate', {})),
    withCatalog('toggle_quantum', (p) => dispatch('aq:analysis:quantum', { mode: p?.mode || 'on' })),
    withCatalog('download_analysis', () => dispatch('aq:analysis:download', {})),
    withCatalog('download_analysis_pdf', () => dispatch('aq:analysis:downloadPdf', {})),
    withCatalog('share_analysis', () => dispatch('aq:analysis:share', {})),
    withCatalog('reset_analysis', () => dispatch('aq:analysis:reset', {})),
    withCatalog('set_analysis_depth', (p) => dispatch('aq:analysis:set', { field: 'depth', value: p?.value || '' })),
    withCatalog('set_analysis_priority', (p) => dispatch('aq:analysis:set', { field: 'priority', value: p?.value || '' })),
    withCatalog('wizard_next', () => dispatch('aq:wizard:next', {})),
    withCatalog('wizard_back', () => dispatch('aq:wizard:back', {})),
    withCatalog('wizard_goto_step', (p) => dispatch('aq:wizard:goto', { step: Number(p?.step) || 1 })),
    withCatalog('open_settings', () => setSettingsOpen(true)),
    withCatalog('close_settings', () => setSettingsOpen(false)),
    withCatalog('set_language', (p) => setLang(p?.value)),
    withCatalog('set_theme', (p) => setThemePersisted(p?.value)),
    withCatalog('open_menu', () => setMenuOpen(true)),
    withCatalog('close_menu', () => setMenuOpen(false)),
    withCatalog('open_about', () => setInfoPanel('about')),
    withCatalog('open_mission', () => setInfoPanel('mission')),
    withCatalog('open_contact', () => setInfoPanel('contact')),
    withCatalog('close_info', () => setInfoPanel(null)),
    withCatalog('open_notifications', () => setNotifOpen(true)),
    withCatalog('close_notifications', () => setNotifOpen(false)),
    withCatalog('expand_sidebar', () => setSidebarCollapsed(false)),
    withCatalog('collapse_sidebar', () => setSidebarCollapsed(true)),
  ];

  // RBAC: user management is only ever advertised/registered for an admin
  // session, mirroring the fact that DashboardPage only renders the
  // "Kullanıcı Yönetimi" button at all when user.isAdmin -- a voice command
  // can never reach a capability the UI itself would not expose to this
  // user (see the RBAC requirement in the voice-assistant spec).
  if (isAdmin) {
    actions.push(withCatalog('open_user_management', () => setUserMgmtOpen(true)));
    actions.push(withCatalog('close_user_management', () => setUserMgmtOpen(false)));
  }

  return actions;
}
