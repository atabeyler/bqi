import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAppMode, isAppModeOffline, setAppMode, subscribeAppModePreference,
} from './appModePreference.js';

beforeEach(() => {
  localStorage.clear();
});

describe('appModePreference', () => {
  it('defaults to "auto" when nothing is stored', () => {
    expect(getAppMode()).toBe('auto');
    expect(isAppModeOffline()).toBe(false);
  });

  it('setAppMode("offline") persists to localStorage and dispatches the CustomEvent', () => {
    const handler = vi.fn();
    window.addEventListener('bqi:app-mode-change', handler);
    setAppMode('offline');
    expect(localStorage.getItem('bqi_app_mode')).toBe('offline');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({ mode: 'offline' });
    window.removeEventListener('bqi:app-mode-change', handler);
  });

  it('isAppModeOffline() reflects the current stored state', () => {
    setAppMode('offline');
    expect(isAppModeOffline()).toBe(true);
    setAppMode('auto');
    expect(isAppModeOffline()).toBe(false);
  });

  it('a subscriber registered via subscribeAppModePreference receives the update', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeAppModePreference(cb);
    setAppMode('offline');
    expect(cb).toHaveBeenCalledWith('offline');
    unsubscribe();
    setAppMode('auto');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid mode value without corrupting stored state', () => {
    setAppMode('offline');
    const result = setAppMode('bogus');
    expect(result).toBe('offline');
    expect(getAppMode()).toBe('offline');
    expect(localStorage.getItem('bqi_app_mode')).toBe('offline');
  });

  it('uses a distinct localStorage key/event from localModePreference.js', () => {
    setAppMode('offline');
    // localModePreference.js's own key must be untouched by this module.
    expect(localStorage.getItem('bqi_force_local_mode')).toBeNull();
  });
});

describe('appModePreference / offline-login separation', () => {
  it('appModePreference.js and the auth session.js modules never import each other', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));

    const appModeSrc = fs.readFileSync(path.join(here, 'appModePreference.js'), 'utf8');
    expect(appModeSrc).not.toMatch(/(?:import|require)[^\n]*session\.js/);

    const desktopSessionPath = path.join(here, '..', '..', '..', 'desktop', 'auth', 'session.js');
    const mobileSessionPath = path.join(here, '..', 'mobile', 'auth', 'session.js');
    for (const p of [desktopSessionPath, mobileSessionPath]) {
      if (fs.existsSync(p)) {
        const src = fs.readFileSync(p, 'utf8');
        expect(src).not.toMatch(/appModePreference/);
      }
    }
  });

  it('setting the app mode does not touch any offline-login localStorage keys', () => {
    setAppMode('offline');
    setAppMode('auto');
    expect(localStorage.getItem('bqi_force_local_mode')).toBeNull();
    // Offline-login state lives in each platform's own secure/native store,
    // never localStorage -- there is nothing here for this preference to
    // collide with either way, which this asserts as a smoke check.
  });
});
