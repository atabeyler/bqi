import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Same fake-DB-over-services/database.js pattern as routes/auth.test.js --
// models only the auth_users + webauthn_credentials SQL routes/webauthn.js
// actually issues, so the route logic (ceremony flow, ownership scoping,
// generic errors) can be integration-tested with supertest without a real
// Postgres instance or real WebAuthn cryptography.
let authUsers;
let credentials; // id -> row
let nextCredId;
let auditLog;

function resetFakeDb() {
  authUsers = new Map();
  credentials = new Map();
  nextCredId = 1;
  auditLog = [];
}

const queryMock = vi.fn(async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s.startsWith('SELECT * FROM auth_users WHERE user_code = $1')) {
    const row = authUsers.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (s.startsWith('SELECT credential_id, transports FROM webauthn_credentials WHERE user_code = $1')) {
    const rows = [...credentials.values()].filter((c) => c.user_code === params[0]);
    return { rows, rowCount: rows.length };
  }

  if (s.startsWith('INSERT INTO webauthn_credentials')) {
    const [userCode, credentialId, publicKey, counter, deviceName, deviceType, backedUp, transports] = params;
    if ([...credentials.values()].some((c) => c.credential_id === credentialId)) {
      return { rows: [], rowCount: 0 };
    }
    const row = {
      id: nextCredId++,
      user_code: userCode,
      credential_id: credentialId,
      public_key: publicKey,
      counter,
      device_name: deviceName,
      device_type: deviceType,
      backed_up: backedUp,
      transports,
      created_at: new Date(),
      last_used_at: null,
    };
    credentials.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }

  if (s.startsWith('SELECT * FROM webauthn_credentials WHERE user_code = $1 ORDER BY')) {
    const rows = [...credentials.values()].filter((c) => c.user_code === params[0]);
    return { rows, rowCount: rows.length };
  }

  if (s.startsWith('UPDATE webauthn_credentials SET device_name = $1 WHERE id = $2 AND user_code = $3')) {
    const [deviceName, id, userCode] = params;
    const row = credentials.get(id);
    if (!row || row.user_code !== userCode) return { rows: [], rowCount: 0 };
    row.device_name = deviceName;
    return { rows: [row], rowCount: 1 };
  }

  if (s.startsWith('DELETE FROM webauthn_credentials WHERE id = $1 AND user_code = $2')) {
    const [id, userCode] = params;
    const row = credentials.get(id);
    if (!row || row.user_code !== userCode) return { rows: [], rowCount: 0 };
    credentials.delete(id);
    return { rows: [{ device_name: row.device_name }], rowCount: 1 };
  }

  if (s.startsWith('SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND user_code = $2')) {
    const [credentialId, userCode] = params;
    const row = [...credentials.values()].find((c) => c.credential_id === credentialId && c.user_code === userCode);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (s.startsWith('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2')) {
    const [counter, id] = params;
    const row = credentials.get(id);
    if (row) { row.counter = counter; row.last_used_at = new Date(); }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  throw new Error(`Unmocked query in webauthn.test.js fake DB: ${s}`);
});

const logAuditEventMock = vi.fn(async (actor, action, targetUserCode = null, details = null) => {
  auditLog.push({ actor: actor.userCode, action, targetUserCode, details });
});

vi.mock('../services/database.js', () => ({
  query: (...args) => queryMock(...args),
  logAuditEvent: (...args) => logAuditEventMock(...args),
}));

// Rate limiting isn't what these tests exercise, and this file makes far
// more than 10 requests/min against one supertest app instance -- mocked
// out to a no-op, same as routes/emergency.test.js.
vi.mock('../middleware/rateLimit.js', () => ({
  publicActionLimiter: (req, res, next) => next(),
}));

// Real webauthnChallengeStore is backed by a module-level Map with a 5min
// TTL -- fine in production, but its state would otherwise leak between
// this file's many tests reusing the same user codes. A tiny fake here
// (reset in beforeEach below) keeps each test's challenge lifecycle
// isolated while still exercising the real save/consume/one-time-use
// contract that routes/webauthn.js relies on.
let challengeStore;
vi.mock('../lib/webauthnChallengeStore.js', () => ({
  saveChallenge: async (key, challenge) => { challengeStore.set(key, challenge); },
  consumeChallenge: async (key) => {
    const v = challengeStore.get(key);
    challengeStore.delete(key);
    return v ?? null;
  },
}));

// The real @simplewebauthn/server does full COSE/CBOR/ASN.1 cryptographic
// verification against a real browser-produced attestation/assertion --
// out of scope to fabricate in a unit test. Mocked here so each test
// controls verified:true/false directly and route logic (challenge
// handling, ownership checks, counter updates, error shapes) is what's
// actually exercised.
const generateRegistrationOptionsMock = vi.fn(async () => ({ challenge: 'reg-challenge-abc' }));
const verifyRegistrationResponseMock = vi.fn();
const generateAuthenticationOptionsMock = vi.fn(async () => ({ challenge: 'auth-challenge-xyz' }));
const verifyAuthenticationResponseMock = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args) => generateRegistrationOptionsMock(...args),
  verifyRegistrationResponse: (...args) => verifyRegistrationResponseMock(...args),
  generateAuthenticationOptions: (...args) => generateAuthenticationOptionsMock(...args),
  verifyAuthenticationResponse: (...args) => verifyAuthenticationResponseMock(...args),
}));

process.env.WEBAUTHN_RP_ID = 'localhost';
process.env.WEBAUTHN_ORIGINS = 'http://localhost:10000';

const { default: webauthnRouter } = await import('./webauthn.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webauthn', webauthnRouter);
  return app;
}

function userToken(userCode, nickname = 'Nick') {
  return jwt.sign({ userCode, nickname, isAdmin: false }, JWT_SECRET, { expiresIn: '1h' });
}

async function seedUser({ userCode, nickname = 'Nick', isAdmin = false, blocked = false, role = 'analyst' }) {
  authUsers.set(userCode, { user_code: userCode, password_hash: 'x', nickname, is_admin: isAdmin, blocked, role, created_at: new Date() });
}

beforeEach(() => {
  resetFakeDb();
  challengeStore = new Map();
  queryMock.mockClear();
  logAuditEventMock.mockClear();
  generateRegistrationOptionsMock.mockClear();
  verifyRegistrationResponseMock.mockReset();
  generateAuthenticationOptionsMock.mockClear();
  verifyAuthenticationResponseMock.mockReset();
});

describe('POST /api/webauthn/register/options', () => {
  it('rejects an unauthenticated request', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/webauthn/register/options').send({});
    expect(res.status).toBe(401);
  });

  it('returns options for a logged-in user and stores the challenge', async () => {
    await seedUser({ userCode: 'U1' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/webauthn/register/options')
      .set('Authorization', `Bearer ${userToken('U1')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('reg-challenge-abc');
    expect(generateRegistrationOptionsMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/webauthn/register/verify', () => {
  async function getOptions(app, token) {
    return request(app).post('/api/webauthn/register/options').set('Authorization', `Bearer ${token}`).send({});
  }

  it('rejects when the challenge was never requested (or already used)', async () => {
    await seedUser({ userCode: 'U1' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/webauthn/register/verify')
      .set('Authorization', `Bearer ${userToken('U1')}`)
      .send({ response: { id: 'cred-1' }, deviceName: 'My Phone' });
    expect(res.status).toBe(400);
  });

  it('stores a new credential on successful verification, never persisting a private key or biometric data', async () => {
    await seedUser({ userCode: 'U1' });
    const app = buildApp();
    const token = userToken('U1');
    await getOptions(app, token);

    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-1', publicKey: Buffer.from('fake-public-key'), counter: 0, transports: ['internal'] },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });

    const res = await request(app)
      .post('/api/webauthn/register/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ response: { id: 'cred-1' }, deviceName: 'My Phone' });

    expect(res.status).toBe(201);
    expect(res.body.credential.deviceName).toBe('My Phone');
    // The stored row shape only ever holds public data.
    const stored = [...credentials.values()][0];
    expect(stored.public_key).toBeTruthy();
    expect(stored).not.toHaveProperty('privateKey');
    expect(JSON.stringify(stored)).not.toMatch(/biometric/i);
    expect(logAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'U1' }), 'webauthn_credential_added', 'U1', expect.any(Object));
  });

  it('rejects when the authenticator response fails cryptographic verification', async () => {
    await seedUser({ userCode: 'U1' });
    const app = buildApp();
    const token = userToken('U1');
    await getOptions(app, token);
    verifyRegistrationResponseMock.mockResolvedValue({ verified: false });

    const res = await request(app)
      .post('/api/webauthn/register/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ response: { id: 'cred-1' } });
    expect(res.status).toBe(400);
  });

  it('consumes the challenge so it cannot be replayed', async () => {
    await seedUser({ userCode: 'U1' });
    const app = buildApp();
    const token = userToken('U1');
    await getOptions(app, token);
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-1', publicKey: Buffer.from('k'), counter: 0, transports: [] },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const first = await request(app).post('/api/webauthn/register/verify').set('Authorization', `Bearer ${token}`).send({ response: { id: 'cred-1' } });
    expect(first.status).toBe(201);

    const replay = await request(app).post('/api/webauthn/register/verify').set('Authorization', `Bearer ${token}`).send({ response: { id: 'cred-1' } });
    expect(replay.status).toBe(400);
  });
});

describe('credential management', () => {
  it('lists only the caller\'s own credentials', async () => {
    await seedUser({ userCode: 'U1' });
    credentials.set(1, { id: 1, user_code: 'U1', credential_id: 'c1', device_name: 'Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null });
    credentials.set(2, { id: 2, user_code: 'OTHER', credential_id: 'c2', device_name: 'Other Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null });
    nextCredId = 3;

    const app = buildApp();
    const res = await request(app).get('/api/webauthn/credentials').set('Authorization', `Bearer ${userToken('U1')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].deviceName).toBe('Phone');
  });

  it('refuses to rename another account\'s credential', async () => {
    await seedUser({ userCode: 'U1' });
    credentials.set(1, { id: 1, user_code: 'OTHER', credential_id: 'c1', device_name: 'Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null });
    nextCredId = 2;

    const app = buildApp();
    const res = await request(app)
      .patch('/api/webauthn/credentials/1')
      .set('Authorization', `Bearer ${userToken('U1')}`)
      .send({ deviceName: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(credentials.get(1).device_name).toBe('Phone');
  });

  it('refuses to delete another account\'s credential', async () => {
    await seedUser({ userCode: 'U1' });
    credentials.set(1, { id: 1, user_code: 'OTHER', credential_id: 'c1', device_name: 'Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null });
    nextCredId = 2;

    const app = buildApp();
    const res = await request(app).delete('/api/webauthn/credentials/1').set('Authorization', `Bearer ${userToken('U1')}`);
    expect(res.status).toBe(404);
    expect(credentials.has(1)).toBe(true);
  });

  it('lets the owner rename and remove their own credential', async () => {
    await seedUser({ userCode: 'U1' });
    credentials.set(1, { id: 1, user_code: 'U1', credential_id: 'c1', device_name: 'Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null });
    nextCredId = 2;
    const app = buildApp();
    const token = userToken('U1');

    const renamed = await request(app).patch('/api/webauthn/credentials/1').set('Authorization', `Bearer ${token}`).send({ deviceName: 'iPhone 15' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.credential.deviceName).toBe('iPhone 15');

    const removed = await request(app).delete('/api/webauthn/credentials/1').set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(200);
    expect(credentials.has(1)).toBe(false);
    expect(logAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'U1' }), 'webauthn_credential_removed', 'U1', expect.any(Object));
  });
});

describe('POST /api/webauthn/login/options', () => {
  it('returns options even for a user code with no registered passkeys (enumeration-safe)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/webauthn/login/options').send({ userCode: 'no-such-user' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('auth-challenge-xyz');
  });

  it('rejects a missing user code', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/webauthn/login/options').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/webauthn/login/verify', () => {
  async function registerCredential(userCode) {
    credentials.set(1, {
      id: 1, user_code: userCode, credential_id: 'cred-1', public_key: 'fake-pk-b64url', counter: 4,
      device_name: 'Phone', device_type: 'singleDevice', backed_up: false, transports: '', created_at: new Date(), last_used_at: null,
    });
    nextCredId = 2;
  }

  it('rejects when no login/options challenge was ever requested', async () => {
    await seedUser({ userCode: 'U1' });
    await registerCredential('U1');
    const app = buildApp();
    const res = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Kimlik doğrulama başarısız');
  });

  it('rejects an assertion for a credential id that belongs to a different account (no cross-account replay)', async () => {
    await seedUser({ userCode: 'U1' });
    await registerCredential('SOMEONE-ELSE');
    const app = buildApp();
    await request(app).post('/api/webauthn/login/options').send({ userCode: 'U1' });

    const res = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(res.status).toBe(401);
    expect(verifyAuthenticationResponseMock).not.toHaveBeenCalled();
  });

  it('rejects a failed cryptographic verification', async () => {
    await seedUser({ userCode: 'U1' });
    await registerCredential('U1');
    const app = buildApp();
    await request(app).post('/api/webauthn/login/options').send({ userCode: 'U1' });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: false });

    const res = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(res.status).toBe(401);
  });

  it('rejects a blocked account even with a valid passkey', async () => {
    await seedUser({ userCode: 'U1', blocked: true });
    await registerCredential('U1');
    const app = buildApp();
    await request(app).post('/api/webauthn/login/options').send({ userCode: 'U1' });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });

    const res = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(res.status).toBe(403);
  });

  it('issues a session cookie + JWT and bumps the stored counter on success', async () => {
    await seedUser({ userCode: 'U1', nickname: 'Nick', role: 'analyst' });
    await registerCredential('U1');
    const app = buildApp();
    await request(app).post('/api/webauthn/login/options').send({ userCode: 'U1' });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });

    const res = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.userCode).toBe('U1');
    expect(res.body.jwt).toBeTruthy();
    expect(res.headers['set-cookie']?.[0]).toMatch(/bqi_jwt=/);

    const decoded = jwt.verify(res.body.jwt, JWT_SECRET);
    expect(decoded.userCode).toBe('U1');
    expect(decoded.role).toBe('analyst');
    expect(credentials.get(1).counter).toBe(5);
    expect(logAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ user_code: 'U1' }), 'webauthn_login', 'U1', expect.any(Object));
  });

  it('consumes the login challenge so the same assertion cannot be replayed twice', async () => {
    await seedUser({ userCode: 'U1' });
    await registerCredential('U1');
    const app = buildApp();
    await request(app).post('/api/webauthn/login/options').send({ userCode: 'U1' });
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });

    const first = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(first.status).toBe(200);

    const replay = await request(app).post('/api/webauthn/login/verify').send({ userCode: 'U1', response: { id: 'cred-1' } });
    expect(replay.status).toBe(401);
  });
});
