import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import { LangProvider } from './services/langContext.jsx';
import { resolveCurrentUser, AUTH_CHANGED_EVENT } from './services/api.js';
import { fullLogout } from './services/fullLogout.js';
import { wasBrowserFullyClosedRecently } from './services/tabPresence.js';

vi.mock('./services/api.js', () => ({
  resolveCurrentUser: vi.fn(),
  hydrateNativeSession: vi.fn().mockResolvedValue(undefined),
  AUTH_CHANGED_EVENT: 'bqi:auth-changed',
}));
// Web-build stub -- App.jsx only ever calls nativeAuth.getSession() through
// hydrateNativeSession(), which is itself mocked to a no-op above, so this
// just needs to exist as an importable shape, not do anything real.
vi.mock('./services/nativeBridge.js', () => ({
  nativeAuth: { getSession: vi.fn() },
  isNativeApp: false,
}));
vi.mock('./services/fullLogout.js', () => ({ fullLogout: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./services/tabPresence.js', () => ({
  startTabHeartbeat: vi.fn(),
  stopTabHeartbeat: vi.fn(),
  wasBrowserFullyClosedRecently: vi.fn().mockReturnValue(false),
}));
vi.mock('./components/IdleLogoutGuard.jsx', () => ({ default: () => null }));

vi.mock('./pages/LoginPage.jsx', () => ({ default: ({ onLogin }) => <button onClick={() => onLogin({ userCode: 'U1', nickname: 'BOLD-001', isAdmin: false })}>login-stub</button> }));
vi.mock('./pages/DashboardPage.jsx', () => ({ default: ({ user }) => <div>dashboard-stub-{user?.userCode}</div> }));
vi.mock('./pages/ButtonShowcasePage.jsx', () => ({ default: () => <div>buttons-stub</div> }));
vi.mock('./pages/CyberAnalysisPage.jsx', () => ({ default: () => <div>cyber-page-stub</div> }));
vi.mock('./components/GlobalVoiceAssistant.jsx', () => ({ default: () => null }));
vi.mock('./components/SplashScreen.jsx', () => ({ default: () => <div>splash-stub</div> }));
vi.mock('./components/UpdateBanner.jsx', () => ({ default: () => null }));

function renderApp(initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><LangProvider><App /></LangProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.Capacitor = undefined;
});

describe('App', () => {
  it('shows the global BQI splash in an ordinary browser tab', () => {
    resolveCurrentUser.mockResolvedValue(null);
    renderApp('/');
    expect(screen.getByText('splash-stub')).toBeInTheDocument();
  });

  it('does not stack the global BQI splash before the BCI route splash', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    resolveCurrentUser.mockResolvedValue({ userCode: 'ADMIN', isAdmin: true });
    renderApp('/cyber-analysis');
    await waitFor(() => expect(screen.getByText('cyber-page-stub')).toBeInTheDocument());
    expect(screen.queryByText('splash-stub')).not.toBeInTheDocument();
  });

  it('shows nothing routable while the initial auth resolution is pending, avoiding a login-page flash', async () => {
    let resolve;
    resolveCurrentUser.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderApp();

    expect(screen.queryByText('login-stub')).not.toBeInTheDocument();
    expect(screen.queryByText(/dashboard-stub/)).not.toBeInTheDocument();

    resolve(null);
    await waitFor(() => expect(screen.getByText('login-stub')).toBeInTheDocument());
  });

  it('renders the dashboard directly when resolveCurrentUser finds an existing session (web cookie or native JWT)', async () => {
    resolveCurrentUser.mockResolvedValue({ userCode: 'U9', nickname: 'BOLD-009', isAdmin: false });
    renderApp();
    await waitFor(() => expect(screen.getByText('dashboard-stub-U9')).toBeInTheDocument());
  });

  it('redirects to the login stub when there is no session', async () => {
    resolveCurrentUser.mockResolvedValue(null);
    renderApp();
    await waitFor(() => expect(screen.getByText('login-stub')).toBeInTheDocument());
  });

  it('re-resolves and shows the dashboard after a successful login', async () => {
    resolveCurrentUser.mockResolvedValue(null);
    renderApp();
    const loginButton = await screen.findByText('login-stub');
    fireEvent.click(loginButton);
    await waitFor(() => expect(screen.getByText('dashboard-stub-U1')).toBeInTheDocument());
  });

  it('re-resolves on AUTH_CHANGED_EVENT (e.g. after logout elsewhere in the app)', async () => {
    resolveCurrentUser.mockResolvedValueOnce({ userCode: 'U9', nickname: 'BOLD-009', isAdmin: false });
    renderApp();
    await waitFor(() => expect(screen.getByText('dashboard-stub-U9')).toBeInTheDocument());

    resolveCurrentUser.mockResolvedValueOnce(null);
    window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByText('login-stub')).toBeInTheDocument());
  });

  it('ends a still-valid session cookie before resolving the user when no tab has been open recently (browser was actually closed)', async () => {
    wasBrowserFullyClosedRecently.mockReturnValue(true);
    resolveCurrentUser.mockResolvedValue({ userCode: 'U9', nickname: 'BOLD-009', isAdmin: false });
    renderApp();
    await waitFor(() => expect(fullLogout).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('login-stub')).toBeInTheDocument()); // never shows the dashboard of a session that was just ended
    expect(resolveCurrentUser).not.toHaveBeenCalled();
  });

  it('does not force a logout on an ordinary refresh (another/this tab was open recently)', async () => {
    wasBrowserFullyClosedRecently.mockReturnValue(false);
    resolveCurrentUser.mockResolvedValue({ userCode: 'U9', nickname: 'BOLD-009', isAdmin: false });
    renderApp();
    await waitFor(() => expect(screen.getByText('dashboard-stub-U9')).toBeInTheDocument());
    expect(fullLogout).not.toHaveBeenCalled();
  });
});
