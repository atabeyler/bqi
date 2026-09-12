/**
 * Thin wrapper around @simplewebauthn/browser -- keeps the rest of the app
 * (LoginPage.jsx, AppMenus.jsx's Security tab) from touching the raw
 * navigator.credentials API, WebAuthn error types, or which platform's
 * ceremony path is in use directly, and gives a single place to
 * feature-detect support across iPhone/iPad (Face ID/Touch ID), Windows
 * (Hello), Mac (Touch ID) and Android (device biometrics).
 *
 * Android is the one exception to "just call the browser API": a Capacitor
 * WebView does not reliably expose a working navigator.credentials for an
 * app served from its own custom origin, so on Android this module routes
 * through the native PasskeyCredential plugin instead
 * (mobile/android/app/src/main/java/.../passkey/PasskeyPlugin.kt, backed by
 * Android's Jetpack Credential Manager) -- it speaks the exact same
 * WebAuthn Level 3 JSON wire format @simplewebauthn/browser does, so
 * api.webauthn.*'s options/response shapes and the server
 * (routes/webauthn.js) need zero changes either way.
 *
 * Either path prompts the OS-level platform authenticator for a biometric/
 * PIN check itself; the result of that check never passes through this
 * code or the network -- only the signed challenge response does, which
 * the server verifies cryptographically.
 */
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Capacitor } from '@capacitor/core';
import { api } from './api.js';

// Only on Android, and only once the native plugin is actually registered
// (an older installed APK built before this plugin existed still runs this
// same JS bundle after an OTA-style web update, so presence is checked at
// call time rather than assumed from the platform alone).
function androidPasskeyPlugin() {
  if (Capacitor.getPlatform() !== 'android') return null;
  return Capacitor.Plugins?.PasskeyCredential || null;
}

export function isPasskeySupported() {
  if (androidPasskeyPlugin()) return true;
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

// Runs the full registration ceremony against the caller's own,
// already-authenticated account: fetch options -> prompt the platform
// authenticator -> send the signed attestation back for verification.
export async function registerPasskey(deviceName) {
  const options = await api.webauthn.registerOptions();
  const plugin = androidPasskeyPlugin();
  const response = plugin
    ? JSON.parse((await plugin.register({ requestJson: JSON.stringify(options) })).registrationResponseJson)
    : await startRegistration({ optionsJSON: options });
  return api.webauthn.registerVerify(response, deviceName);
}

// Runs the full login ceremony for a given user code, returning the same
// { status: 'approved', jwt, userCode, nickname, isAdmin, role } shape
// api.loginRequest()'s admin path returns, so LoginPage.jsx can share its
// existing "log the user in" handling.
export async function loginWithPasskey(userCode) {
  const options = await api.webauthn.loginOptions(userCode);
  const plugin = androidPasskeyPlugin();
  const response = plugin
    ? JSON.parse((await plugin.authenticate({ requestJson: JSON.stringify(options) })).authenticationResponseJson)
    : await startAuthentication({ optionsJSON: options });
  return api.webauthn.loginVerify(userCode, response);
}
