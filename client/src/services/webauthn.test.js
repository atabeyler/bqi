import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startRegistrationMock = vi.fn();
const startAuthenticationMock = vi.fn();
const browserSupportsWebAuthnMock = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: (...args) => startRegistrationMock(...args),
  startAuthentication: (...args) => startAuthenticationMock(...args),
  browserSupportsWebAuthn: (...args) => browserSupportsWebAuthnMock(...args),
}));

const registerOptionsMock = vi.fn();
const registerVerifyMock = vi.fn();
const loginOptionsMock = vi.fn();
const loginVerifyMock = vi.fn();
vi.mock('./api.js', () => ({
  api: {
    webauthn: {
      registerOptions: (...args) => registerOptionsMock(...args),
      registerVerify: (...args) => registerVerifyMock(...args),
      loginOptions: (...args) => loginOptionsMock(...args),
      loginVerify: (...args) => loginVerifyMock(...args),
    },
  },
}));

const { isPasskeySupported, registerPasskey, loginWithPasskey } = await import('./webauthn.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPasskeySupported', () => {
  it('reflects the underlying browser check', () => {
    browserSupportsWebAuthnMock.mockReturnValue(true);
    expect(isPasskeySupported()).toBe(true);
    browserSupportsWebAuthnMock.mockReturnValue(false);
    expect(isPasskeySupported()).toBe(false);
  });

  it('fails closed (false) if the underlying check throws', () => {
    browserSupportsWebAuthnMock.mockImplementation(() => { throw new Error('no navigator.credentials'); });
    expect(isPasskeySupported()).toBe(false);
  });
});

describe('registerPasskey', () => {
  it('fetches options, prompts the platform authenticator, then sends the signed response for verification', async () => {
    registerOptionsMock.mockResolvedValue({ challenge: 'c1' });
    startRegistrationMock.mockResolvedValue({ id: 'cred-1' });
    registerVerifyMock.mockResolvedValue({ success: true });

    const result = await registerPasskey('My Phone');

    expect(registerOptionsMock).toHaveBeenCalled();
    expect(startRegistrationMock).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c1' } });
    expect(registerVerifyMock).toHaveBeenCalledWith({ id: 'cred-1' }, 'My Phone');
    expect(result).toEqual({ success: true });
  });

  it('propagates a WebAuthn ceremony failure (e.g. the user cancels the biometric prompt) without calling verify', async () => {
    registerOptionsMock.mockResolvedValue({ challenge: 'c1' });
    startRegistrationMock.mockRejectedValue(new Error('cancelled'));

    await expect(registerPasskey()).rejects.toThrow('cancelled');
    expect(registerVerifyMock).not.toHaveBeenCalled();
  });
});

describe('loginWithPasskey', () => {
  it('fetches options for the given user code, prompts the authenticator, then verifies', async () => {
    loginOptionsMock.mockResolvedValue({ challenge: 'c2' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    loginVerifyMock.mockResolvedValue({ status: 'approved', jwt: 'jwt-token', userCode: 'U1' });

    const result = await loginWithPasskey('U1');

    expect(loginOptionsMock).toHaveBeenCalledWith('U1');
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c2' } });
    expect(loginVerifyMock).toHaveBeenCalledWith('U1', { id: 'cred-1' });
    expect(result.jwt).toBe('jwt-token');
  });
});

describe('Android native PasskeyCredential plugin path', () => {
  afterEach(() => {
    vi.doUnmock('@capacitor/core');
    vi.resetModules();
  });

  async function loadWithAndroidPlugin(pluginMock) {
    vi.doMock('@capacitor/core', () => ({
      Capacitor: { getPlatform: () => 'android', Plugins: { PasskeyCredential: pluginMock } },
    }));
    vi.resetModules();
    return import('./webauthn.js');
  }

  it('reports supported when the native plugin is registered, without a browser API call', async () => {
    const { isPasskeySupported } = await loadWithAndroidPlugin({});
    expect(isPasskeySupported()).toBe(true);
    expect(browserSupportsWebAuthnMock).not.toHaveBeenCalled();
  });

  it('falls back to the browser check when running on Android but the plugin is not registered (older bundle)', async () => {
    vi.doMock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android', Plugins: {} } }));
    vi.resetModules();
    browserSupportsWebAuthnMock.mockReturnValue(false);
    const { isPasskeySupported } = await import('./webauthn.js');
    expect(isPasskeySupported()).toBe(false);
  });

  it('registerPasskey routes through the native plugin and never touches startRegistration', async () => {
    const register = vi.fn(async () => ({ registrationResponseJson: JSON.stringify({ id: 'native-cred-1' }) }));
    const { registerPasskey } = await loadWithAndroidPlugin({ register });
    registerOptionsMock.mockResolvedValue({ challenge: 'c1' });
    registerVerifyMock.mockResolvedValue({ success: true });

    const result = await registerPasskey('My Phone');

    expect(register).toHaveBeenCalledWith({ requestJson: JSON.stringify({ challenge: 'c1' }) });
    expect(startRegistrationMock).not.toHaveBeenCalled();
    expect(registerVerifyMock).toHaveBeenCalledWith({ id: 'native-cred-1' }, 'My Phone');
    expect(result).toEqual({ success: true });
  });

  it('loginWithPasskey routes through the native plugin and never touches startAuthentication', async () => {
    const authenticate = vi.fn(async () => ({ authenticationResponseJson: JSON.stringify({ id: 'native-cred-1' }) }));
    const { loginWithPasskey } = await loadWithAndroidPlugin({ authenticate });
    loginOptionsMock.mockResolvedValue({ challenge: 'c2' });
    loginVerifyMock.mockResolvedValue({ status: 'approved', jwt: 'jwt-token' });

    const result = await loginWithPasskey('U1');

    expect(authenticate).toHaveBeenCalledWith({ requestJson: JSON.stringify({ challenge: 'c2' }) });
    expect(startAuthenticationMock).not.toHaveBeenCalled();
    expect(loginVerifyMock).toHaveBeenCalledWith('U1', { id: 'native-cred-1' });
    expect(result.jwt).toBe('jwt-token');
  });
});
