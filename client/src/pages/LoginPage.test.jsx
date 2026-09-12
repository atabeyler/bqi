import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './LoginPage.jsx';
import { LangProvider } from '../services/langContext.jsx';

vi.mock('./LoginPageDecor.jsx', () => ({
  Corner: () => null,
  GridBackground: () => null,
  OrbitalLogo: () => null,
  BootSequence: ({ onDone }) => { onDone(); return null; },
  StatusBar: () => null,
}));
vi.mock('../components/HologramSphere.jsx', () => ({ default: () => null }));
vi.mock('../components/EmergencyButton.jsx', () => ({ default: () => null }));
vi.mock('../components/AppFooter.jsx', () => ({ default: () => null }));
vi.mock('../components/AppMenus.jsx', () => ({ MenuPanel: () => null, SettingsPanel: () => null, InfoModal: () => null, GuideModal: () => null }));
vi.mock('../services/voiceActionRegistry.js', () => ({ registerActions: () => {}, unregisterActions: () => {} }));

const isNativeAppMock = { value: false };
vi.mock('../services/nativeBridge.js', () => ({
  get isNativeApp() { return isNativeAppMock.value; },
  nativeAuth: { establishOnlineSession: vi.fn(() => Promise.resolve({})), verifyOfflineLogin: vi.fn() },
}));

const loginRequestMock = vi.fn();
const setJWTMock = vi.fn();
const setLocalAuthUserMock = vi.fn();
vi.mock('../services/api.js', () => ({
  api: { loginRequest: (...args) => loginRequestMock(...args), checkApproval: vi.fn() },
  setJWT: (...args) => setJWTMock(...args),
  setLocalAuthUser: (...args) => setLocalAuthUserMock(...args),
}));

const isPasskeySupportedMock = vi.fn(() => true);
const loginWithPasskeyMock = vi.fn();
vi.mock('../services/webauthn.js', () => ({
  isPasskeySupported: (...args) => isPasskeySupportedMock(...args),
  loginWithPasskey: (...args) => loginWithPasskeyMock(...args),
}));

function renderLogin(onLogin = vi.fn()) {
  render(<LangProvider><LoginPage onLogin={onLogin} /></LangProvider>);
  return onLogin;
}

beforeEach(() => {
  vi.clearAllMocks();
  isNativeAppMock.value = false;
  isPasskeySupportedMock.mockReturnValue(true);
  localStorage.clear();
  // LoginPage renders via the real i18n system (no `t` prop to stub, unlike
  // AppMenus.jsx) -- pin the language to English so assertions can match
  // stable, readable strings instead of the Turkish default.
  localStorage.setItem('bqi_lang', 'en');
});

describe('LoginPage passkey mode', () => {
  it('shows a disabled passkey option when the browser does not support WebAuthn', async () => {
    isPasskeySupportedMock.mockReturnValue(false);
    renderLogin();
    expect(await screen.findByText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Passkey Unavailable on This Device' })).toBeDisabled();
  });

  it('switches to the passkey form and back via the toggle links', async () => {
    renderLogin();
    fireEvent.click(await screen.findByText('Secure Sign-In with Passkey'));
    expect(screen.getByRole('button', { name: 'Secure Sign-In with Passkey' })).toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('User Code + Password'));
    expect(await screen.findByText('Password')).toBeInTheDocument();
  });

  it('logs the user in directly on a successful passkey ceremony (no mail-approval wait)', async () => {
    loginWithPasskeyMock.mockResolvedValue({ status: 'approved', jwt: 'jwt-1', userCode: 'U1', nickname: 'BOLD-001', role: 'analyst', isAdmin: false });
    const onLogin = renderLogin();

    fireEvent.click(await screen.findByText('Secure Sign-In with Passkey'));
    fireEvent.change(screen.getByPlaceholderText('· · · · · · ·'), { target: { value: 'U1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Secure Sign-In with Passkey' }));

    await waitFor(() => expect(loginWithPasskeyMock).toHaveBeenCalledWith('U1'));
    await waitFor(() => expect(setJWTMock).toHaveBeenCalledWith('jwt-1'));
    expect(onLogin).toHaveBeenCalledWith({ userCode: 'U1', nickname: 'BOLD-001', role: 'analyst', isAdmin: false });
  });

  it('registers this device for offline login on a native app after a successful passkey ceremony, same as password login', async () => {
    isNativeAppMock.value = true;
    const { nativeAuth } = await import('../services/nativeBridge.js');
    loginWithPasskeyMock.mockResolvedValue({ status: 'approved', jwt: 'jwt-1', userCode: 'U1', nickname: 'BOLD-001', role: 'analyst', isAdmin: false });
    renderLogin();

    fireEvent.click(await screen.findByText('Secure Sign-In with Passkey'));
    fireEvent.change(screen.getByPlaceholderText('· · · · · · ·'), { target: { value: 'U1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Secure Sign-In with Passkey' }));

    await waitFor(() => expect(nativeAuth.establishOnlineSession).toHaveBeenCalledWith('jwt-1', undefined));
  });

  it('shows an error and never logs in when the passkey ceremony fails (e.g. the user cancels the biometric prompt)', async () => {
    loginWithPasskeyMock.mockRejectedValue(new Error('User cancelled the operation'));
    const onLogin = renderLogin();

    fireEvent.click(await screen.findByText('Secure Sign-In with Passkey'));
    fireEvent.change(screen.getByPlaceholderText('· · · · · · ·'), { target: { value: 'U1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Secure Sign-In with Passkey' }));

    await waitFor(() => expect(screen.getByText(/User cancelled the operation/)).toBeInTheDocument());
    expect(onLogin).not.toHaveBeenCalled();
    expect(setJWTMock).not.toHaveBeenCalled();
  });

  it('password login is unaffected: submits userCode/password and awaits mail approval as before', async () => {
    loginRequestMock.mockResolvedValue({ token: 'approval-token' });
    renderLogin();

    fireEvent.change(await screen.findByPlaceholderText('· · · · · · ·'), { target: { value: 'U1' } });
    const passwordInput = document.querySelector('input[type="password"]');
    fireEvent.change(passwordInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('REQUEST LOGIN APPROVAL'));

    await waitFor(() => expect(loginRequestMock).toHaveBeenCalledWith('U1', 'secret'));
    expect(await screen.findByText('Login approval requested')).toBeInTheDocument();
  });
});

describe('offline login regression: a stale-but-real cached jwt must not bounce the user back out', () => {
  // The bug this guards: logoutSession() used to null the cached jwt, so a
  // later offline login handed back jwt: null -- setJWT(null) then looked
  // indistinguishable from "still logged out" to anything reacting to
  // AUTH_CHANGED_EVENT. Now logoutSession() preserves the cached jwt
  // (desktop/auth/session.js / client/src/mobile/auth/session.js), so
  // verifyOfflineLogin() here returns a real, non-null (if possibly
  // already-expired) token -- and setLocalAuthUser() is what keeps
  // api.js's getCurrentUser() from immediately re-nulling it on the next
  // check, even though this component doesn't decode expiry itself.
  it('offline login after a prior logout passes the cached jwt to setJWT and registers a local-auth fallback identity', async () => {
    isNativeAppMock.value = true;
    const { nativeAuth } = await import('../services/nativeBridge.js');
    loginRequestMock.mockRejectedValue(new TypeError('Failed to fetch'));
    nativeAuth.verifyOfflineLogin.mockResolvedValue({
      ok: true, jwt: 'cached-jwt-from-before-logout', userCode: 'U1', nickname: 'BOLD-001', isAdmin: false,
    });
    const onLogin = renderLogin();

    fireEvent.change(await screen.findByPlaceholderText('· · · · · · ·'), { target: { value: 'U1' } });
    fireEvent.change(document.querySelector('input[type="password"]'), { target: { value: 'CorrectHorse123' } });
    fireEvent.click(screen.getByText('REQUEST LOGIN APPROVAL'));

    await waitFor(() => expect(nativeAuth.verifyOfflineLogin).toHaveBeenCalledWith('U1', 'CorrectHorse123'));
    expect(setJWTMock).toHaveBeenCalledWith('cached-jwt-from-before-logout');
    expect(setLocalAuthUserMock).toHaveBeenCalledWith({ userCode: 'U1', nickname: 'BOLD-001', isAdmin: false });
    expect(onLogin).toHaveBeenCalledWith({ userCode: 'U1', isAdmin: false });
  });
});
