import { describe, it, expect, vi } from 'vitest';
import { buildDashboardVoiceActions } from './dashboardVoiceActions.js';

function findAction(actions, name) {
  return actions.find((a) => a.name === name);
}

// Security fix: voice-triggered logout used to only clear the in-memory
// JWT (setJWT(null)), never the platform's native secure store -- a
// relaunch after a voice "log out" command silently restored the old
// session and skipped the login screen entirely (same bug as the
// header logout button, see DashboardPage.jsx's logout()). The catalog
// handler must now prefer the page's own performLogout() (which does
// clear the native store) over the bare fallback sequence.
describe('buildDashboardVoiceActions logout action', () => {
  it('calls performLogout() when supplied, instead of the bare fallback', () => {
    const performLogout = vi.fn();
    const setJWT = vi.fn();
    const disconnectSocket = vi.fn();
    const onLogout = vi.fn();

    const actions = buildDashboardVoiceActions({
      setView: vi.fn(), setActiveCategory: vi.fn(), setHistoryOpen: vi.fn(),
      setVoiceChatOpen: vi.fn(), setGuideOpen: vi.fn(), setJWT, disconnectSocket, onLogout,
      performLogout, dispatch: vi.fn(),
    });

    findAction(actions, 'logout').handler();

    expect(performLogout).toHaveBeenCalledTimes(1);
    expect(setJWT).not.toHaveBeenCalled();
    expect(disconnectSocket).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('falls back to setJWT(null)/disconnectSocket()/onLogout() when performLogout is not supplied', () => {
    const setJWT = vi.fn();
    const disconnectSocket = vi.fn();
    const onLogout = vi.fn();

    const actions = buildDashboardVoiceActions({
      setView: vi.fn(), setActiveCategory: vi.fn(), setHistoryOpen: vi.fn(),
      setVoiceChatOpen: vi.fn(), setGuideOpen: vi.fn(), setJWT, disconnectSocket, onLogout,
      dispatch: vi.fn(),
    });

    findAction(actions, 'logout').handler();

    expect(setJWT).toHaveBeenCalledWith(null);
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
