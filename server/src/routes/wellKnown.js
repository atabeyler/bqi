import express from 'express';

const router = express.Router();

// Android package name is fixed by the shipped app (mobile/android/app/
// build.gradle's `namespace`/`applicationId`), never configurable per
// deployment.
const ANDROID_PACKAGE_NAME = 'com.boldas.bqi';

// Digital Asset Links, required before Android's Credential Manager
// (client-side: mobile/android/app/src/main/java/.../passkey/
// PasskeyPlugin.kt) will let this app create/use a passkey scoped to this
// server's WebAuthn RP ID (lib/webauthnConfig.js) -- Android fetches this
// exact file from https://<rpId>/.well-known/assetlinks.json itself and
// checks the calling app's own signing certificate against
// sha256_cert_fingerprints below before allowing either ceremony to
// complete; this route has no other role in that check.
//
// ANDROID_PASSKEY_CERT_FINGERPRINTS is the release (and, for local/staging
// testing, debug) keystore's SHA-256 certificate fingerprint(s), colon-
// delimited hex as `keytool -list -v` prints them (e.g.
// "AA:BB:CC:...:FF"), comma-separated for more than one. Get it from the
// actual signing keystore: `keytool -list -v -keystore <path> -alias
// <alias>` and copy the "SHA256:" line. Unset (the default) serves 404 --
// same fail-safe-off pattern as other optional integrations in this repo
// (see validateEnv.js) -- rather than a broken empty assetlinks.json that
// would make Android reject every passkey attempt with no clear cause.
router.get('/assetlinks.json', (_req, res) => {
  const raw = (process.env.ANDROID_PASSKEY_CERT_FINGERPRINTS || '').trim();
  if (!raw) return res.status(404).json({ error: 'Not configured' });

  const fingerprints = raw.split(',').map((f) => f.trim()).filter(Boolean);
  res.json([
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

export default router;
