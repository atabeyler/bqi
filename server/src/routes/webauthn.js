/**
 * Passkey/WebAuthn support -- an alternative login method to user code +
 * password, not a replacement. Registering a device (Face ID/Touch ID/
 * Windows Hello/Android biometrics) requires an existing authenticated
 * session first (see /register/options and /register/verify below); the
 * biometric/PIN check itself always happens locally on the user's device
 * inside the platform authenticator and its result never reaches this
 * server -- only a challenge signed with the credential's private key does,
 * which @simplewebauthn/server verifies cryptographically against the
 * public key stored at registration. No private key and no biometric data
 * is ever sent to or stored by this API.
 *
 * Mirrors routes/auth.js's and routes/devices.js's conventions: raw SQL via
 * services/database.js (this is auth-domain data, kept out of the Drizzle
 * schema like auth_users/approval_tokens), the same generic error messages
 * and per-account lockout as password login (lib/loginThrottle.js) to avoid
 * turning passkey login into a fresh user-enumeration or brute-force
 * surface, and admin_audit_log entries for every credential add/remove and
 * every passkey login.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { query, logAuditEvent } from '../services/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { publicActionLimiter } from '../middleware/rateLimit.js';
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from '../lib/loginThrottle.js';
import { JWT_SECRET } from '../lib/jwtSecret.js';
import { setAuthCookie } from '../lib/cookies.js';
import { RP_NAME, RP_ID, EXPECTED_ORIGINS } from '../lib/webauthnConfig.js';
import { saveChallenge, consumeChallenge } from '../lib/webauthnChallengeStore.js';
import { ROLES } from '../lib/rbac.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// Generic, enumeration-safe error for every failure mode of the login
// ceremony (unknown user code, no registered passkey, bad/expired
// challenge, signature verification failure) -- deliberately identical
// wording/status regardless of which of those actually happened, matching
// routes/auth.js's unified "Kullanıcı kodu veya şifre hatalı" approach for
// password login.
const LOGIN_FAILED_MSG = 'Kimlik doğrulama başarısız';

function toCredentialJson(row) {
  return {
    id: row.id,
    deviceName: row.device_name || 'Passkey',
    deviceType: row.device_type,
    backedUp: !!row.backed_up,
    transports: row.transports ? row.transports.split(',').filter(Boolean) : [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

async function findUser(userCode) {
  const { rows } = await query('SELECT * FROM auth_users WHERE user_code = $1', [userCode]);
  return rows[0] || null;
}

// ── Registration: adding a passkey to the caller's own, already-logged-in
// account (Security section of the app) ─────────────────────────────────
router.post('/register/options', authMiddleware, publicActionLimiter, async (req, res) => {
  try {
    const { userCode, nickname } = req.user;
    const { rows: existing } = await query(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_code = $1',
      [userCode]
    );

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: userCode,
      userDisplayName: nickname || userCode,
      attestationType: 'none',
      // Prevents the same authenticator being registered twice for one account.
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? c.transports.split(',').filter(Boolean) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    await saveChallenge(`reg:${userCode}`, options.challenge);
    res.json(options);
  } catch (err) {
    logger.error({ err }, '[WebAuthn] register/options failed');
    res.status(500).json({ error: 'Passkey kaydı başlatılamadı' });
  }
});

router.post('/register/verify', authMiddleware, publicActionLimiter, async (req, res) => {
  try {
    const { userCode } = req.user;
    const { response, deviceName } = req.body || {};
    if (!response) {
      return res.status(400).json({ error: 'Geçersiz istek' });
    }

    const expectedChallenge = await consumeChallenge(`reg:${userCode}`);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Kayıt süresi doldu, lütfen tekrar deneyin' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
    } catch (err) {
      logger.warn({ err }, '[WebAuthn] registration verification threw');
      return res.status(400).json({ error: 'Passkey doğrulanamadı' });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey doğrulanamadı' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const credentialIdB64 = credential.id;
    const publicKeyB64 = isoBase64URL.fromBuffer(credential.publicKey);
    const transports = (credential.transports || []).join(',');
    const safeName = (typeof deviceName === 'string' ? deviceName.trim() : '').slice(0, 200) || null;

    const { rows } = await query(
      `INSERT INTO webauthn_credentials
         (user_code, credential_id, public_key, counter, device_name, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (credential_id) DO NOTHING
       RETURNING *`,
      [userCode, credentialIdB64, publicKeyB64, credential.counter, safeName, credentialDeviceType, credentialBackedUp, transports]
    );

    if (rows.length === 0) {
      // Extremely unlikely (credential IDs are large random values), but a
      // duplicate here would otherwise silently look like success.
      return res.status(409).json({ error: 'Bu passkey zaten kayıtlı' });
    }

    await logAuditEvent(req.user, 'webauthn_credential_added', userCode, { deviceName: safeName, deviceType: credentialDeviceType });
    res.status(201).json({ success: true, credential: toCredentialJson(rows[0]) });
  } catch (err) {
    logger.error({ err }, '[WebAuthn] register/verify failed');
    res.status(500).json({ error: 'Passkey kaydı tamamlanamadı' });
  }
});

// ── Credential management (Security section) ──────────────────────────────
router.get('/credentials', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM webauthn_credentials WHERE user_code = $1 ORDER BY created_at ASC',
      [req.user.userCode]
    );
    res.json(rows.map(toCredentialJson));
  } catch (err) {
    logger.error({ err }, '[WebAuthn] list credentials failed');
    res.status(500).json({ error: err.message });
  }
});

router.patch('/credentials/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const deviceName = String(req.body?.deviceName || '').trim().slice(0, 200);
    if (!id || !deviceName) {
      return res.status(400).json({ error: 'Geçersiz istek' });
    }
    // Scoped by user_code alongside id so a user can never rename another
    // account's credential even by guessing its numeric id.
    const { rows } = await query(
      'UPDATE webauthn_credentials SET device_name = $1 WHERE id = $2 AND user_code = $3 RETURNING *',
      [deviceName, id, req.user.userCode]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Passkey bulunamadı' });
    res.json({ success: true, credential: toCredentialJson(rows[0]) });
  } catch (err) {
    logger.error({ err }, '[WebAuthn] rename credential failed');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/credentials/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Geçersiz istek' });

    const { rows } = await query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_code = $2 RETURNING device_name',
      [id, req.user.userCode]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Passkey bulunamadı' });

    await logAuditEvent(req.user, 'webauthn_credential_removed', req.user.userCode, { deviceName: rows[0].device_name });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[WebAuthn] remove credential failed');
    res.status(500).json({ error: err.message });
  }
});

// ── Login: passkey as an alternative to /api/auth/login-request ─────────
// Requires a user code up front (no discoverable/usernameless flow yet) so
// the challenge can be scoped to that account's registered credentials --
// same shape as the existing password flow's first step.
router.post('/login/options', publicActionLimiter, async (req, res) => {
  try {
    const userCode = String(req.body?.userCode || '').trim();
    if (!userCode) {
      return res.status(400).json({ error: 'Kullanıcı kodu zorunlu' });
    }
    if (await isLoginLocked(userCode)) {
      return res.status(429).json({ error: 'Çok fazla hatalı deneme. Lütfen birkaç dakika sonra tekrar deneyin.' });
    }

    // Always queried and always used to build options, whether or not any
    // row comes back, so a nonexistent user code takes the same code path
    // (and roughly the same time) as one with zero registered passkeys --
    // this endpoint alone must not become a way to enumerate accounts.
    const { rows } = await query(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_code = $1',
      [userCode]
    );

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: rows.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? c.transports.split(',').filter(Boolean) : undefined,
      })),
    });

    await saveChallenge(`auth:${userCode}`, options.challenge);
    res.json(options);
  } catch (err) {
    logger.error({ err }, '[WebAuthn] login/options failed');
    res.status(500).json({ error: 'Passkey girişi başlatılamadı' });
  }
});

router.post('/login/verify', publicActionLimiter, async (req, res) => {
  try {
    const userCode = String(req.body?.userCode || '').trim();
    const { response } = req.body || {};
    if (!userCode || !response) {
      return res.status(400).json({ error: 'Geçersiz istek' });
    }

    if (await isLoginLocked(userCode)) {
      return res.status(429).json({ error: 'Çok fazla hatalı deneme. Lütfen birkaç dakika sonra tekrar deneyin.' });
    }

    const expectedChallenge = await consumeChallenge(`auth:${userCode}`);
    if (!expectedChallenge) {
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: LOGIN_FAILED_MSG });
    }

    // Ownership check: the asserted credential id must belong to the user
    // code the challenge was scoped to, so a signed assertion for account A
    // can never be replayed to authenticate as account B.
    const { rows: credRows } = await query(
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND user_code = $2',
      [response.id, userCode]
    );
    if (credRows.length === 0) {
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: LOGIN_FAILED_MSG });
    }
    const credRow = credRows[0];

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        credential: {
          id: credRow.credential_id,
          publicKey: isoBase64URL.toBuffer(credRow.public_key),
          counter: Number(credRow.counter),
          transports: credRow.transports ? credRow.transports.split(',').filter(Boolean) : undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      logger.warn({ err }, '[WebAuthn] authentication verification threw');
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: LOGIN_FAILED_MSG });
    }

    if (!verification.verified) {
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: LOGIN_FAILED_MSG });
    }

    const user = await findUser(userCode);
    if (!user) {
      // Credential row referenced a user_code that no longer has an
      // account (e.g. deleted after being renamed) -- same generic error.
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: LOGIN_FAILED_MSG });
    }
    if (user.blocked) {
      return res.status(403).json({ error: 'Hesabınız engellenmiş. Merkez ile iletişime geçin.' });
    }

    await clearLoginFailures(userCode);
    await query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2',
      [verification.authenticationInfo.newCounter, credRow.id]
    );

    const role = user.role || (user.is_admin ? ROLES.ADMIN : ROLES.ANALYST);
    const expiresIn = user.is_admin ? '4h' : '2h';
    const jwtToken = jwt.sign(
      { userCode: user.user_code, nickname: user.nickname, isAdmin: !!user.is_admin, role },
      JWT_SECRET,
      { expiresIn }
    );
    setAuthCookie(res, jwtToken, (user.is_admin ? 4 : 2) * 60 * 60 * 1000);

    await logAuditEvent(user, 'webauthn_login', user.user_code, { deviceName: credRow.device_name });

    res.json({
      status: 'approved',
      jwt: jwtToken,
      userCode: user.user_code,
      nickname: user.nickname,
      isAdmin: !!user.is_admin,
      role,
    });
  } catch (err) {
    logger.error({ err }, '[WebAuthn] login/verify failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
