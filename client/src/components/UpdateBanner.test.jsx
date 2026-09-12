import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

afterEach(() => {
  delete window.bqiDesktop;
  localStorage.removeItem('bqi_app_mode');
  vi.doUnmock('@capacitor/core');
  vi.resetModules();
});

describe('UpdateBanner (web build)', () => {
  it('renders nothing on the plain web build (neither desktop nor Android)', async () => {
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const { container } = render(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateBanner (Offline Mode)', () => {
  it('does not check for updates on desktop when Offline Mode is already on', async () => {
    const { setAppMode } = await import('../services/appModePreference.js');
    setAppMode('offline');
    const getAvailable = vi.fn(async () => ({ available: false }));
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: () => () => {}, onProgress: () => () => {}, getAvailable },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    render(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(getAvailable).not.toHaveBeenCalled();
  });

  it('stops a running desktop update check when Offline Mode flips on mid-session', async () => {
    const appModePref = await import('../services/appModePreference.js');
    let pushAvailable;
    const getAvailable = vi.fn(async () => ({ available: false }));
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: (cb) => { pushAvailable = cb; return () => {}; }, onProgress: () => () => {}, getAvailable },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    render(<UpdateBanner />);
    await waitFor(() => expect(getAvailable).toHaveBeenCalledTimes(1));

    act(() => { pushAvailable({ available: true, version: '2.1.140', notes: '' }); });
    await waitFor(() => expect(screen.getByText('A new version is available: v2.1.140')).toBeInTheDocument());

    act(() => { appModePref.setAppMode('offline'); });
    // The banner's own effect tears down (returning from the useEffect
    // callback via the appModeOffline guard) -- no further check calls fire.
    getAvailable.mockClear();
    await new Promise((r) => setTimeout(r, 0));
    expect(getAvailable).not.toHaveBeenCalled();
  });
});

describe('UpdateBanner (desktop)', () => {
  it('renders nothing when no update is available', async () => {
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: () => () => {}, onProgress: () => () => {} },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the version and, on approval, downloads then offers install', async () => {
    let pushAvailable;
    const approve = vi.fn(async () => ({ ok: true }));
    const install = vi.fn();
    window.bqiDesktop = {
      isDesktop: true,
      update: {
        onAvailable: (cb) => { pushAvailable = cb; return () => {}; },
        onProgress: () => () => {},
        approve,
        install,
      },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    render(<UpdateBanner />);

    act(() => { pushAvailable({ available: true, version: '2.1.140', notes: '' }); });
    await waitFor(() => expect(screen.getByText('A new version is available: v2.1.140')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));
    expect(approve).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('Install and Restart')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Install and Restart'));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('shows an error state when the download fails', async () => {
    let pushAvailable;
    const approve = vi.fn(async () => ({ ok: false, error: 'boom' }));
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: (cb) => { pushAvailable = cb; return () => {}; }, onProgress: () => () => {}, approve, install: vi.fn() },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    render(<UpdateBanner />);

    act(() => { pushAvailable({ available: true, version: '2.1.140' }); });
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => expect(screen.getByText('Download failed.')).toBeInTheDocument());
  });

  it('lets the user retry the download after a failure', async () => {
    let pushAvailable;
    const approve = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
      .mockResolvedValueOnce({ ok: true });
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: (cb) => { pushAvailable = cb; return () => {}; }, onProgress: () => () => {}, approve, install: vi.fn() },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    render(<UpdateBanner />);

    act(() => { pushAvailable({ available: true, version: '2.1.140' }); });
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(screen.getByText('Download failed.')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Try Again'));
    expect(approve).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('Install and Restart')).toBeInTheDocument());
  });

  it('dismissing the banner hides it', async () => {
    let pushAvailable;
    window.bqiDesktop = {
      isDesktop: true,
      update: { onAvailable: (cb) => { pushAvailable = cb; return () => {}; }, onProgress: () => () => {} },
    };
    vi.resetModules();
    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const { container } = render(<UpdateBanner />);

    act(() => { pushAvailable({ available: true, version: '2.1.140' }); });
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Close'));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateBanner (Android)', () => {
  it('checks the server on mount and downloads/installs the APK on approval', async () => {
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
    vi.resetModules();
    // mobileBridge's own bootstrap does a plain fetch() health check -- keep it harmless.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const mobileBridge = await import('../services/mobileBridge.js');
    mobileBridge.mobileUpdate.check = vi.fn(async () => ({ available: true, version: '2.1.140', url: 'https://x/app.apk', sha256: 'abc123' }));
    const approve = vi.fn(async () => {});
    mobileBridge.mobileUpdate.approve = approve;

    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByText('A new version is available: v2.1.140')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));
    expect(approve).toHaveBeenCalledWith('https://x/app.apk', 'abc123');

    vi.unstubAllGlobals();
  });

  it('shows an error state when the download/install hand-off fails', async () => {
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const mobileBridge = await import('../services/mobileBridge.js');
    mobileBridge.mobileUpdate.check = vi.fn(async () => ({ available: true, version: '2.1.140', url: 'https://x/app.apk' }));
    mobileBridge.mobileUpdate.approve = vi.fn(async () => { throw new Error('boom'); });

    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByText('Update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => expect(screen.getByText('Download failed.')).toBeInTheDocument());

    vi.unstubAllGlobals();
  });

  it('retries the check on a 5-minute interval so a failed cold-start attempt still surfaces a later update', async () => {
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    vi.useFakeTimers();

    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const mobileBridge = await import('../services/mobileBridge.js');
    let available = false;
    const check = vi.fn(async () => (available ? { available: true, version: '2.1.140', url: 'https://x/app.apk' } : { available: false }));
    mobileBridge.mobileUpdate.check = check;

    render(<UpdateBanner />);
    await act(async () => { await Promise.resolve(); });
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/A new version is available/)).not.toBeInTheDocument();

    available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.getByText('A new version is available: v2.1.140')).toBeInTheDocument();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The Android WebView commonly throttles/suspends JS timers while
  // backgrounded (screen lock, switching apps) -- the 5-minute interval
  // alone silently stalls and never "catches up", so a release published
  // while the app sat backgrounded produced no banner until it was fully
  // quit and relaunched. visibilitychange must trigger an immediate re-check
  // on its own, not wait for the next lucky interval tick.
  it('re-checks immediately when the app becomes visible again, not just on the interval', async () => {
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const mobileBridge = await import('../services/mobileBridge.js');
    let available = false;
    const check = vi.fn(async () => (available ? { available: true, version: '2.1.140', url: 'https://x/app.apk' } : { available: false }));
    mobileBridge.mobileUpdate.check = check;

    render(<UpdateBanner />);
    await act(async () => { await Promise.resolve(); });
    expect(check).toHaveBeenCalledTimes(1);

    // The app was backgrounded and a release landed while it sat there --
    // simulate coming back to the foreground well before the 5-minute
    // interval would ever fire on its own.
    available = true;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.getByText('A new version is available: v2.1.140')).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('does not check for updates when Offline Mode is already on', async () => {
    const appModePref = await import('../services/appModePreference.js');
    appModePref.setAppMode('offline');
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const { default: UpdateBanner } = await import('./UpdateBanner.jsx');
    const mobileBridge = await import('../services/mobileBridge.js');
    const check = vi.fn(async () => ({ available: true, version: '2.1.140', url: 'https://x/app.apk' }));
    mobileBridge.mobileUpdate.check = check;

    render(<UpdateBanner />);
    await act(async () => { await Promise.resolve(); });
    expect(check).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
