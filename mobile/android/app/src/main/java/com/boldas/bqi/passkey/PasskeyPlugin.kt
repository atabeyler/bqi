package com.boldas.bqi.passkey

import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Capacitor plugin backing `window.Capacitor.Plugins.PasskeyCredential`, the
 * native seam client/src/services/webauthn.js calls on Android instead of
 * the bare `navigator.credentials` API (which the Android System WebView
 * does not reliably expose -- see that file's comment). Bridges to
 * Android's Jetpack Credential Manager (`androidx.credentials`), which talks
 * the same WebAuthn Level 3 JSON wire format `@simplewebauthn/browser`
 * already produces/consumes on desktop and web -- server/src/routes/
 * webauthn.js and lib/webauthnConfig.js need zero changes for this.
 *
 * Android verifies this app is authorized to act on behalf of the server's
 * RP ID origin via Digital Asset Links (the app's package name + signing
 * certificate SHA-256, checked against
 * https://<rpId>/.well-known/assetlinks.json -- see server/src/routes/
 * wellKnown.js) before it will let a passkey be created/used for that
 * origin; this plugin has no part in that check, Android performs it
 * itself before either method below is ever allowed to complete.
 *
 *   - isSupported() -> {supported} -- Credential Manager is a Jetpack
 *     library, not an OS feature, so this is always true on this project's
 *     minSdk 24; a device with no actual passkey provider (Google Password
 *     Manager, a third-party manager, ...) still resolves true here and
 *     instead surfaces as a rejected register()/authenticate() call, same
 *     as @simplewebauthn/browser's own feature-detection-only contract.
 *   - register({requestJson}) -> {registrationResponseJson}
 *   - authenticate({requestJson}) -> {authenticationResponseJson}
 *
 * requestJson/registrationResponseJson/authenticationResponseJson are
 * passed through verbatim as opaque JSON strings -- this plugin never
 * parses their contents, it only hands them to/from Credential Manager, so
 * a future change to the options/response shape on the server or JS side
 * needs no matching change here.
 */
@CapacitorPlugin(name = "PasskeyCredential")
class PasskeyPlugin : Plugin() {

    // Main dispatcher: Credential Manager's createCredential/getCredential
    // launch a system UI flow (biometric/PIN prompt, account picker) that
    // needs to run against the Activity's own lifecycle, unlike the
    // LocalLLM plugin's blocking JNI call which is deliberately kept off
    // the main thread instead (see that plugin's class comment) -- these
    // two native plugins have opposite threading needs for opposite reasons.
    private val scope = CoroutineScope(Dispatchers.Main)

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val ret = JSObject()
        ret.put("supported", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val requestJson = call.getString("requestJson")
        if (requestJson.isNullOrBlank()) {
            call.reject("requestJson is required")
            return
        }
        val hostActivity = activity
        if (hostActivity == null) {
            call.reject("passkey_no_activity")
            return
        }
        scope.launch {
            try {
                val credentialManager = CredentialManager.create(context)
                val request = CreatePublicKeyCredentialRequest(requestJson)
                val response = credentialManager.createCredential(hostActivity, request) as CreatePublicKeyCredentialResponse
                val ret = JSObject()
                ret.put("registrationResponseJson", response.registrationResponseJson)
                call.resolve(ret)
            } catch (e: CreateCredentialException) {
                call.reject("passkey_register_failed: ${e.type} ${e.message}", e)
            } catch (t: Throwable) {
                call.reject("passkey_register_failed: ${t.message}", t.toString())
            }
        }
    }

    @PluginMethod
    fun authenticate(call: PluginCall) {
        val requestJson = call.getString("requestJson")
        if (requestJson.isNullOrBlank()) {
            call.reject("requestJson is required")
            return
        }
        val hostActivity = activity
        if (hostActivity == null) {
            call.reject("passkey_no_activity")
            return
        }
        scope.launch {
            try {
                val credentialManager = CredentialManager.create(context)
                val option = GetPublicKeyCredentialOption(requestJson)
                val request = GetCredentialRequest(listOf(option))
                val result = credentialManager.getCredential(hostActivity, request)
                val credential = result.credential as PublicKeyCredential
                val ret = JSObject()
                ret.put("authenticationResponseJson", credential.authenticationResponseJson)
                call.resolve(ret)
            } catch (e: GetCredentialException) {
                call.reject("passkey_authenticate_failed: ${e.type} ${e.message}", e)
            } catch (t: Throwable) {
                call.reject("passkey_authenticate_failed: ${t.message}", t.toString())
            }
        }
    }
}
