import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { query, logAuditEvent, getPool } from '../services/database.js';
import { sendApprovalEmail } from '../services/email.js';
import { authMiddleware } from '../middleware/auth.js';
import { publicActionLimiter, adminActionLimiter } from '../middleware/rateLimit.js';
import * as onlineState from '../lib/onlineState.js';
import { JWT_SECRET } from '../lib/jwtSecret.js';
import { escapeHtml } from '../lib/escapeHtml.js';
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from '../lib/loginThrottle.js';
import { invalidateBlockedCache } from '../lib/blockedUserCache.js';
import { ROLES } from '../lib/rbac.js';
import { setAuthCookie, clearAuthCookie } from '../lib/cookies.js';
import { validatePassword } from '../lib/passwordPolicy.js';

const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:10000';

// Bootstrap account seeding. User-code inventories must not live in the
// repository, especially now that deployments can be public. The only built-in
// bootstrap identity is the first admin; additional users may be provided by
// operators through BOOTSTRAP_USERS_JSON and are inserted without overwriting
// existing accounts. After login, account management goes through /admin/users.
const SHARED_SEED_PASSWORD = process.env.SHARED_PASSWORD;
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD || (process.env.NODE_ENV === 'development' ? SHARED_SEED_PASSWORD : undefined);
const ADMIN_SEED_USER_CODE = process.env.ADMIN_SEED_USER_CODE || (process.env.NODE_ENV === 'development' ? 'dev-admin' : undefined);
const ADMIN_SEED_NICKNAME = process.env.ADMIN_SEED_NICKNAME || 'BOLD';
const ADMIN_SEED_RESET = process.env.ADMIN_SEED_RESET === 'true';

function parseBootstrapUsers() {
  if (!process.env.BOOTSTRAP_USERS_JSON) return [];
  try {
    const users = JSON.parse(process.env.BOOTSTRAP_USERS_JSON);
    if (!Array.isArray(users)) throw new Error('must be a JSON array');
    return users
      .map((u) => ({
        userCode: String(u.userCode || '').trim(),
        nickname: String(u.nickname || u.userCode || '').trim(),
        isAdmin: false,
      }))
      .filter((u) => u.userCode && u.nickname);
  } catch (err) {
    console.error('BOOTSTRAP_USERS_JSON ignored: invalid JSON array of { userCode, nickname } objects:', err.message);
    return [];
  }
}

let seeded = false;
async function seedBootstrapUsersIfNeeded() {
  if (seeded || !process.env.DATABASE_URL) return;
  seeded = true;
  try {
    if (!ADMIN_SEED_USER_CODE) {
      console.error(
        `auth_users seed ABORTED: ADMIN_SEED_USER_CODE is not set (NODE_ENV=${process.env.NODE_ENV || '(unset)'}). Refusing to ` +
        'seed an admin account without an operator-provided user code.'
      );
      seeded = false;
      return;
    }
    if (!ADMIN_SEED_PASSWORD) {
      console.error(
        `auth_users seed ABORTED: ADMIN_SEED_PASSWORD is not set (NODE_ENV=${process.env.NODE_ENV || '(unset)'}). Refusing to ` +
        `seed the admin account (${ADMIN_SEED_USER_CODE}) without a distinct bootstrap password.`
      );
      seeded = false;
      return;
    }
    const bootstrapUsers = parseBootstrapUsers();
    if (bootstrapUsers.length > 0 && !SHARED_SEED_PASSWORD) {
      console.error('non-admin bootstrap users skipped: SHARED_PASSWORD env var is not set');
    }
    if (ADMIN_SEED_PASSWORD === SHARED_SEED_PASSWORD) {
      // BQI-007: this is a real "admin uses a weaker/shared path than
      // non-admin users" gap -- the admin account would be bootstrapped
      // with the exact same bcrypt hash as non-admin bootstrap
      // accounts, so anyone holding SHARED_PASSWORD (a deploy log, an
      // ex-operator, a leaked env var) gets admin too. A warning alone was
      // easy to miss at deploy time; fail closed instead so a boot without
      // a distinct ADMIN_SEED_PASSWORD never silently seeds a shared admin
      // credential -- gated on NODE_ENV !== 'development' (not
      // === 'production') since a reachable staging/test deployment left
      // with NODE_ENV unset or something other than 'production' is
      // exactly the case this is meant to catch; only explicit local
      // development (.env.example's default) keeps the previous
      // warn-and-continue behavior so local setup isn't broken.
      if (process.env.NODE_ENV !== 'development') {
        console.error(
          `auth_users seed ABORTED: ADMIN_SEED_PASSWORD matches SHARED_PASSWORD (NODE_ENV=${process.env.NODE_ENV || '(unset)'}). Refusing to ` +
          `seed the admin account (${ADMIN_SEED_USER_CODE}) with the same bootstrap password as non-admin bootstrap accounts -- set a ` +
          'distinct ADMIN_SEED_PASSWORD and restart, or set NODE_ENV=development for local-only setups.'
        );
        seeded = false; // allow a retry once the operator sets it and restarts
        return;
      }
      console.warn(
        `auth_users seed: ADMIN_SEED_PASSWORD matches SHARED_PASSWORD -- the admin account (${ADMIN_SEED_USER_CODE}) is being seeded ` +
        'with the SAME bootstrap password as every non-admin bootstrap account. Set ADMIN_SEED_PASSWORD to a ' +
        'distinct value and rotate the admin password immediately after first login.'
      );
    }

    const adminPasswordHash = await bcrypt.hash(ADMIN_SEED_PASSWORD, 12);
    const analystPasswordHash = bootstrapUsers.length > 0 && SHARED_SEED_PASSWORD
      ? await bcrypt.hash(SHARED_SEED_PASSWORD, 12)
      : null;
    const seedUsers = [
      { userCode: ADMIN_SEED_USER_CODE, nickname: ADMIN_SEED_NICKNAME, isAdmin: true },
      ...(analystPasswordHash ? bootstrapUsers : []),
    ];
    for (const u of seedUsers) {
      const passwordHash = u.isAdmin ? adminPasswordHash : analystPasswordHash;
      if (u.isAdmin && ADMIN_SEED_RESET) {
        await query(
          `INSERT INTO auth_users (user_code, password_hash, nickname, is_admin, role, blocked)
           VALUES ($1, $2, $3, TRUE, $4, FALSE)
           ON CONFLICT (user_code) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               nickname = EXCLUDED.nickname,
               is_admin = TRUE,
               role = $4,
               blocked = FALSE`,
          [u.userCode, passwordHash, u.nickname, ROLES.ADMIN]
        );
      } else {
        await query(
          'INSERT INTO auth_users (user_code, password_hash, nickname, is_admin) VALUES ($1, $2, $3, $4) ON CONFLICT (user_code) DO NOTHING',
          [u.userCode, passwordHash, u.nickname, u.isAdmin]
        );
      }
    }
    console.log('auth_users bootstrap seed checked; missing configured users inserted without overwriting existing accounts');
  } catch (err) {
    console.error('auth_users seed error:', err);
  }
}

async function findUser(userCode) {
  const { rows } = await query('SELECT * FROM auth_users WHERE user_code = $1', [userCode]);
  return rows[0] || null;
}

// A precomputed bcrypt hash (same cost factor as real ones, see bcrypt.hash
// calls below) with no corresponding real password -- compared against on
// the "user not found" path in /login-request so that path takes about the
// same time as a real wrong-password compare, instead of returning
// immediately. Without this, response timing alone lets an attacker
// distinguish a valid user code from an invalid one even though the error
// message is now identical (see the unified "Kullanıcı kodu veya şifre
// hatalı" message below).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password-timing-decoy', 12);

// Step 1: verify the password, generate a token for mail approval, and send the email
router.post('/login-request', publicActionLimiter, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: 'Kullanıcı veritabanı yapılandırılmamış' });
    }
    await seedBootstrapUsersIfNeeded();

    const { userCode, password } = req.body;
    if (!userCode || !password) {
      return res.status(400).json({ error: 'Kullanıcı kodu ve şifre zorunlu' });
    }

    if (await isLoginLocked(userCode)) {
      return res.status(429).json({ error: 'Çok fazla hatalı deneme. Lütfen birkaç dakika sonra tekrar deneyin.' });
    }

    // Same generic error message and roughly the same response time whether
    // the user code doesn't exist or the password is wrong -- distinguishing
    // the two (as this used to) lets an attacker enumerate valid user codes
    // by trying candidates and watching which error/timing comes back.
    const user = await findUser(userCode);
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) {
      await recordLoginFailure(userCode);
      return res.status(401).json({ error: 'Kullanıcı kodu veya şifre hatalı' });
    }

    await clearLoginFailures(userCode);

    if (user.blocked) {
      return res.status(403).json({ error: 'Hesabınız engellenmiş. Merkez ile iletişime geçin.' });
    }

    // Admin: no mail approval, direct JWT
    if (user.is_admin) {
      const jwtToken = jwt.sign(
        { userCode: user.user_code, nickname: user.nickname, isAdmin: true, role: ROLES.ADMIN },
        JWT_SECRET,
        { expiresIn: '4h' }
      );
      const { exp } = jwt.decode(jwtToken);
      setAuthCookie(res, jwtToken, 4 * 60 * 60 * 1000);
      return res.json({ status: 'approved', jwt: jwtToken, userCode: user.user_code, nickname: user.nickname, isAdmin: true, role: ROLES.ADMIN, exp });
    }

    const token = uuid();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await query(
      'INSERT INTO approval_tokens (token, user_code, expires_at) VALUES ($1, $2, $3)',
      [token, userCode, expiresAt]
    );

    const approveUrl = `${APP_URL}/api/auth/approve/${token}`;
    const rejectUrl = `${APP_URL}/api/auth/reject/${token}`;

    // Fire-and-forget: the Resend API round-trip (DNS+TLS+HTTP) can run
    // 1-9s depending on network conditions, and the client doesn't need the
    // email to actually be sent before it starts polling /check/:token --
    // it only needs the approval_tokens row, already inserted above.
    // Blocking the response on this turned every non-admin login into a
    // multi-second wait for no functional reason.
    sendApprovalEmail(userCode, approveUrl, rejectUrl).catch((err) => {
      console.error('sendApprovalEmail error:', err);
    });

    res.json({ success: true, token, message: 'Merkez onayı bekleniyor — info@boldkimya.com.tr adresine onay maili gönderildi.' });
  } catch (err) {
    console.error('login-request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: the approval link coming from the email.
// GET only renders a confirmation page with a button that POSTs the actual
// action -- corporate mail-security link scanners/prefetchers auto-fetch
// GET links, which would otherwise silently approve a login before a human
// ever looked at the email (defeating the whole point of mail approval).
router.get('/approve/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await query(
      'SELECT 1 FROM approval_tokens WHERE token = $1 AND expires_at > NOW() AND approved = FALSE',
      [token]
    );
    if (r.rowCount === 0) {
      return res.status(400).send(htmlPage('error', 'Token geçersiz veya süresi dolmuş'));
    }
    res.send(confirmPage('approve', token, 'Girişi Onayla', 'Bu kullanıcının sisteme girişini onaylamak istediğinize emin misiniz?'));
  } catch (err) {
    res.status(500).send(htmlPage('error', err.message));
  }
});

router.post('/approve/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const r = await query(
      'UPDATE approval_tokens SET approved = TRUE WHERE token = $1 AND expires_at > NOW() AND approved = FALSE RETURNING *',
      [token]
    );
    if (r.rowCount === 0) {
      return res.status(400).send(htmlPage('error', 'Token geçersiz veya süresi dolmuş'));
    }

    res.send(htmlPage('success', 'Giriş onaylandı. Kullanıcı şimdi sisteme giriş yapabilir.'));
  } catch (err) {
    res.status(500).send(htmlPage('error', err.message));
  }
});

router.get('/reject/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const r = await query('SELECT 1 FROM approval_tokens WHERE token = $1', [token]);
    if (r.rowCount === 0) {
      return res.status(400).send(htmlPage('error', 'Token geçersiz veya süresi dolmuş'));
    }
    res.send(confirmPage('reject', token, 'Girişi Reddet', 'Bu kullanıcının giriş talebini reddetmek istediğinize emin misiniz?'));
  } catch (err) {
    res.status(500).send(htmlPage('error', err.message));
  }
});

router.post('/reject/:token', async (req, res) => {
  try {
    const { token } = req.params;
    await query('DELETE FROM approval_tokens WHERE token = $1', [token]);
    res.send(htmlPage('reject', 'Giriş reddedildi.'));
  } catch (err) {
    res.status(500).send(htmlPage('error', err.message));
  }
});

// Step 3: the frontend polls the approval status
router.get('/check/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const r = await query('SELECT * FROM approval_tokens WHERE token = $1', [token]);
    if (r.rowCount === 0) return res.json({ status: 'not_found' });
    const t = r.rows[0];
    const expired = new Date(t.expires_at) < new Date();

    if (expired) return res.json({ status: 'expired' });
    if (!t.approved) return res.json({ status: 'pending' });

    const user = await findUser(t.user_code);
    // The account this token was issued for may have been deleted between
    // the approval email being sent and it being clicked -- fail closed
    // instead of falling back to a default ANALYST role for a nonexistent
    // account, which would silently mint a JWT nobody actually owns.
    if (!user) {
      await query('DELETE FROM approval_tokens WHERE token = $1', [token]);
      return res.status(404).json({ status: 'not_found', error: 'Kullanıcı bulunamadı' });
    }
    if (user.blocked) {
      return res.status(403).json({ status: 'blocked', error: 'Hesabınız engellenmiş' });
    }
    // isAdmin is derived from the SAME resolved role that goes into the
    // token, not read separately off the DB row -- otherwise a user whose
    // `role` and `is_admin` columns disagree (see the admin-user-management
    // routes below, which now keep the two in sync on every write, but a
    // pre-existing row could still diverge) would get a token where
    // rbac.js's requireRole(ADMIN) and this file's own requireAdmin()
    // (which checks isAdmin) disagree about whether the user is an admin.
    const nickname = user.nickname || t.user_code;
    const role = user.role || ROLES.ANALYST;
    const isAdmin = role === ROLES.ADMIN;

    // Consume the token atomically before issuing the JWT: an approval
    // token is meant to authorize exactly one login, not act as a standing
    // bearer credential that mints a fresh 2h session on every poll until
    // it expires. The DELETE...RETURNING also resolves a concurrent-poll
    // race -- only the request that actually deletes the row gets to issue
    // the JWT; a duplicate in-flight request sees rowCount 0.
    const consumed = await query('DELETE FROM approval_tokens WHERE token = $1 RETURNING token', [token]);
    if (consumed.rowCount === 0) {
      return res.status(409).json({ status: 'not_found', error: 'Token zaten kullanıldı' });
    }

    const jwtToken = jwt.sign({ userCode: t.user_code, nickname, role, isAdmin }, JWT_SECRET, { expiresIn: '2h' });
    const { exp } = jwt.decode(jwtToken);
    setAuthCookie(res, jwtToken, 2 * 60 * 60 * 1000);
    res.json({ status: 'approved', jwt: jwtToken, userCode: t.user_code, nickname, role, isAdmin, exp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets the web client (which never has JS access to the httpOnly session
// cookie, unlike desktop/mobile decoding their own stored JWT) learn who's
// logged in without needing to decode a token it doesn't have.
router.get('/me', authMiddleware, (req, res) => {
  const { userCode, nickname, isAdmin, role, exp } = req.user;
  res.json({ userCode, nickname, isAdmin: !!isAdmin, role, exp });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// ── Admin: user management ────────────────────────────────────────────────
// Nickname/password changes are admin-only (via /admin/users/:userCode below) --
// regular users cannot change their own user code or password.
// All /admin/users routes require a valid admin JWT (never client-supplied
// data — isAdmin is only ever set from a DB row via login-request above).
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Yetkisiz' });
  next();
}

function validEmail(email) {
  return email === undefined || email === null || email === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.get('/admin/users', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT user_code, nickname, email, is_admin, blocked, created_at FROM auth_users ORDER BY created_at ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/users', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { userCode, password, nickname, isAdmin, email, role } = req.body;
    if (!userCode || !password) {
      return res.status(400).json({ error: 'Kullanıcı kodu ve şifre zorunlu' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
    }
    if (role !== undefined && !Object.values(ROLES).includes(role)) {
      return res.status(400).json({ error: 'Geçersiz rol' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // An explicit role is honored, otherwise it's derived from isAdmin so
    // existing admin-only clients keep working. is_admin is then always
    // DERIVED from the resolved role (never independently trusted from the
    // request body) so the two columns can never disagree -- previously a
    // caller passing role:'admin' with isAdmin omitted/false created a user
    // where lib/rbac.js's requireRole(ADMIN) (reads `role`) and this file's
    // own requireAdmin() (reads `isAdmin`) granted different sets of routes
    // to the same account.
    const resolvedRole = role || (isAdmin ? ROLES.ADMIN : ROLES.ANALYST);
    const resolvedIsAdmin = resolvedRole === ROLES.ADMIN;
    const { rows } = await query(
      `INSERT INTO auth_users (user_code, password_hash, nickname, is_admin, email, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_code) DO NOTHING
       RETURNING user_code, nickname, email, is_admin, role, blocked, created_at`,
      [userCode, passwordHash, nickname || userCode, resolvedIsAdmin, email || null, resolvedRole]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'Bu kullanıcı kodu zaten kayıtlı' });
    }
    await logAuditEvent(req.user, 'user_added', userCode, { nickname: rows[0].nickname, isAdmin: rows[0].is_admin, role: rows[0].role });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/users/:userCode', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { userCode } = req.params;
    const { password, nickname, isAdmin, blocked, email, role } = req.body;

    if (blocked === true && userCode === req.user.userCode) {
      return res.status(400).json({ error: 'Kendi hesabınızı engelleyemezsiniz' });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
    }
    if (role !== undefined && !Object.values(ROLES).includes(role)) {
      return res.status(400).json({ error: 'Geçersiz rol' });
    }

    const sets = [];
    const params = [];
    if (password) {
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      params.push(await bcrypt.hash(password, 12));
      sets.push(`password_hash = $${params.length}`);
    }
    if (nickname !== undefined) {
      params.push(nickname);
      sets.push(`nickname = $${params.length}`);
    }
    if (email !== undefined) {
      params.push(email || null);
      sets.push(`email = $${params.length}`);
    }
    // is_admin and role are always written together, derived from a single
    // resolved value, so they can never end up disagreeing (see the same
    // fix in POST /admin/users above for the divergence this prevents) --
    // whichever of the two the caller provided wins; if both were provided,
    // `role` is authoritative (matching lib/rbac.js's resolveRole(), which
    // also prefers `role` over the legacy `isAdmin` flag).
    if (role !== undefined || isAdmin !== undefined) {
      const effectiveRole = role !== undefined ? role : (isAdmin ? ROLES.ADMIN : ROLES.ANALYST);
      const effectiveIsAdmin = effectiveRole === ROLES.ADMIN;
      params.push(effectiveIsAdmin);
      sets.push(`is_admin = $${params.length}`);
      params.push(effectiveRole);
      sets.push(`role = $${params.length}`);
    }
    if (blocked !== undefined) {
      params.push(!!blocked);
      sets.push(`blocked = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok' });

    params.push(userCode);
    const r = await query(
      `UPDATE auth_users SET ${sets.join(', ')} WHERE user_code = $${params.length} RETURNING user_code, nickname, email, is_admin, role, blocked, created_at`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const updated = r.rows[0];

    const auditDetails = {};
    if (password) auditDetails.passwordChanged = true;
    if (nickname !== undefined) auditDetails.nickname = nickname;
    if (email !== undefined) auditDetails.email = email;
    if (isAdmin !== undefined) auditDetails.isAdmin = !!isAdmin;
    if (role !== undefined) auditDetails.role = role;
    if (blocked !== undefined) auditDetails.blocked = !!blocked;
    await logAuditEvent(
      req.user,
      blocked === true ? 'user_blocked' : blocked === false ? 'user_unblocked' : 'user_updated',
      userCode,
      auditDetails
    );

    // authMiddleware now re-checks `blocked` on every request via a
    // short-TTL cache (see lib/blockedUserCache.js) rather than only at
    // login, but that cache can still be up to its TTL stale -- update it
    // here immediately so the change takes effect on this (and, via Redis,
    // every) instance right away instead of waiting it out.
    if (blocked !== undefined) {
      await invalidateBlockedCache(userCode, blocked);
    }

    // Also force out an active session immediately when blocking -- this
    // covers realtime (Socket.IO) access, which the blockedUserCache above
    // doesn't touch.
    if (blocked === true && updated.nickname) {
      const io = req.app.get('io');
      const socketId = await onlineState.getOnlineSocketId(updated.nickname);
      if (io && socketId) {
        io.to(socketId).emit('auth:blocked');
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Renames a user's login code. Not folded into the general PATCH above --
// user_code is referenced by column (not an enforced foreign key, see
// services/database.js) across many tables, so a rename has to update all
// of them together inside one transaction, or a partial failure would
// leave some of the user's history orphaned under the old code.
router.post('/admin/users/:userCode/rename', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  const { userCode } = req.params;
  const newUserCode = String(req.body?.newUserCode || '').trim();
  try {
    if (!newUserCode) {
      return res.status(400).json({ error: 'Yeni kullanıcı kodu zorunlu' });
    }
    if (newUserCode.length > 50) {
      return res.status(400).json({ error: 'Kullanıcı kodu en fazla 50 karakter olabilir' });
    }
    if (newUserCode === userCode) {
      return res.status(400).json({ error: 'Yeni kullanıcı kodu eskisiyle aynı olamaz' });
    }
    if (userCode === req.user.userCode) {
      // Renaming your own account would invalidate the JWT/cookie this very
      // request is authenticated with mid-transaction -- simplest to just
      // require doing it from another admin account instead.
      return res.status(400).json({ error: 'Kendi kullanıcı kodunuzu bu ekrandan değiştiremezsiniz' });
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query('SELECT 1 FROM auth_users WHERE user_code = $1', [userCode]);
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      }
      const taken = await client.query('SELECT 1 FROM auth_users WHERE user_code = $1', [newUserCode]);
      if (taken.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Bu kullanıcı kodu zaten kullanımda' });
      }

      await client.query('UPDATE auth_users SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE analyses SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE approval_tokens SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE devices SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE sync_operations SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE messages SET from_user = $1 WHERE from_user = $2', [newUserCode, userCode]);
      await client.query('UPDATE messages SET to_user = $1 WHERE to_user = $2', [newUserCode, userCode]);
      await client.query('UPDATE emergency_logs SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE push_subscriptions SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE admin_audit_log SET actor_user_code = $1 WHERE actor_user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE admin_audit_log SET target_user_code = $1 WHERE target_user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE user_profiles SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE conversation_memory SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE webauthn_credentials SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE decision_records SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);
      await client.query('UPDATE quantum_hardware_jobs SET user_code = $1 WHERE user_code = $2', [newUserCode, userCode]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logAuditEvent(req.user, 'user_renamed', newUserCode, { previousUserCode: userCode });
    res.json({ success: true, userCode: newUserCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/users/:userCode', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { userCode } = req.params;
    if (userCode === req.user.userCode) {
      return res.status(400).json({ error: 'Kendi hesabınızı silemezsiniz' });
    }

    const { rows } = await query('SELECT COUNT(*)::int AS count FROM auth_users WHERE is_admin = TRUE');
    const target = await findUser(userCode);
    if (target?.is_admin && rows[0].count <= 1) {
      return res.status(400).json({ error: 'Son admin hesabı silinemez' });
    }

    await query('DELETE FROM auth_users WHERE user_code = $1', [userCode]);
    await logAuditEvent(req.user, 'user_deleted', userCode, { nickname: target?.nickname });

    if (target?.nickname) {
      const io = req.app.get('io');
      const socketId = await onlineState.getOnlineSocketId(target.nickname);
      if (io && socketId) {
        io.to(socketId).emit('auth:blocked');
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/audit-log', authMiddleware, requireAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, actor_user_code, actor_nickname, action, target_user_code, details, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 200'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function htmlPage(type, message) {
  const colors = {
    success: { bg: '#1a7a3e', icon: '✓' },
    error: { bg: '#7a1a1a', icon: '✗' },
    reject: { bg: '#7a1a1a', icon: '⊘' }
  };
  const c = colors[type] || colors.error;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BQI</title>
  <style>
    body{margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;
         display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .box{background:#11172a;border:1px solid #67e8f9;border-radius:8px;padding:50px;max-width:500px;text-align:center;}
    .icon{font-size:64px;color:${c.bg === '#1a7a3e' ? '#4ade80' : '#ff4444'};margin-bottom:20px;}
    h1{color:#ecfeff;letter-spacing:2px;margin:0 0 16px;}
    p{font-size:16px;line-height:1.6;}
    .footer{margin-top:30px;font-size:11px;color:#666;}
  </style></head>
  <body><div class="box">
    <div class="icon">${c.icon}</div>
    <h1>BQI</h1>
    <p>${escapeHtml(message)}</p>
    <div class="footer">Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.<br>Tüm Hakları Saklıdır</div>
  </div></body></html>`;
}

// GET confirmation step for approve/reject: a mail-security prefetch will
// only ever hit this idempotent read-only page, never the POST below that
// actually performs the action.
function confirmPage(action, token, buttonLabel, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BQI</title>
  <style>
    body{margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;
         display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .box{background:#11172a;border:1px solid #67e8f9;border-radius:8px;padding:50px;max-width:500px;text-align:center;}
    h1{color:#ecfeff;letter-spacing:2px;margin:0 0 16px;}
    p{font-size:16px;line-height:1.6;}
    button{margin-top:20px;padding:12px 32px;background:#67e8f9;color:#0a0e1a;border:none;border-radius:6px;
           font-family:'Times New Roman',serif;font-size:16px;font-weight:bold;cursor:pointer;letter-spacing:1px;}
    button:hover{background:#a5f3fc;}
    .footer{margin-top:30px;font-size:11px;color:#666;}
  </style></head>
  <body><div class="box">
    <h1>BQI</h1>
    <p>${escapeHtml(message)}</p>
    <form method="POST" action="/api/auth/${action}/${encodeURIComponent(token)}">
      <button type="submit">${escapeHtml(buttonLabel)}</button>
    </form>
    <div class="footer">Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.<br>Tüm Hakları Saklıdır</div>
  </div></body></html>`;
}

export default router;
