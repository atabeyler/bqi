import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const sendEmergencyAlertMock = vi.fn(async () => {});
const sendEmergencyBroadcastEmailMock = vi.fn(async () => {});
const getUserEmailRecipientsMock = vi.fn(async () => []);
vi.mock('../services/email.js', () => ({
  sendEmergencyAlert: (...args) => sendEmergencyAlertMock(...args),
  sendEmergencyBroadcastEmail: (...args) => sendEmergencyBroadcastEmailMock(...args),
}));
vi.mock('../services/database.js', () => ({ getUserEmailRecipients: (...args) => getUserEmailRecipientsMock(...args) }));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
// Rate limiting isn't what these tests exercise -- and its key/bucketing
// behavior for supertest's synthetic requests isn't fully deterministic
// (varies with IPv4 vs IPv6 loopback), so mock it out to a no-op here.
vi.mock('../middleware/rateLimit.js', () => ({
  publicActionLimiter: (req, res, next) => next(),
  uploadLimiter: (req, res, next) => next(),
}));

const { default: emergencyRouter } = await import('./emergency.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  const emitted = [];
  app.set('io', { emit: (event, payload) => emitted.push({ event, payload }) });
  app.locals.emitted = emitted;
  app.use('/api/emergency', emergencyRouter);
  return app;
}

function token(userCode = 'BOLD-001') {
  return jwt.sign({ userCode }, JWT_SECRET, { expiresIn: '1h' });
}

// item 13: POST /users (broadcast to every connected client) now requires
// the admin role -- an ordinary authenticated user's own token (above) is
// exactly what an attacker had before that fix, so these tests must
// explicitly grant admin to still exercise the route's own logic.
function adminToken(userCode = 'BOLD-001') {
  return jwt.sign({ userCode, role: 'admin', isAdmin: true }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  sendEmergencyAlertMock.mockClear();
  sendEmergencyBroadcastEmailMock.mockClear();
  getUserEmailRecipientsMock.mockClear();
  getUserEmailRecipientsMock.mockResolvedValue([]);
});

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('POST /api/emergency/center (no auth required)', () => {
  it('accepts a message with no Authorization header, attributed to ANONİM', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/center').send({ message: 'yardım gerekli' });
    expect(res.status).toBe(200);
    expect(sendEmergencyAlertMock).toHaveBeenCalledWith('ANONİM', 'yardım gerekli', undefined);
  });

  it('attributes the message to the token owner when a valid JWT is sent', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/center').set('Authorization', `Bearer ${token('BOLD-007')}`).send({ message: 'test' });
    expect(res.status).toBe(200);
    expect(sendEmergencyAlertMock).toHaveBeenCalledWith('BOLD-007', 'test', undefined);
  });

  it('rejects an empty message', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/center').send({ message: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a message over the length cap', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/center').send({ message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('rejects an overly long region name', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/center').send({ message: 'ok', region: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/emergency/users (requires login -- broadcasts to every connected client)', () => {
  it('rejects a request with no Authorization header', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').send({ message: 'test' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').set('Authorization', 'Bearer not-a-real-token').send({ message: 'test' });
    expect(res.status).toBe(401);
  });

  // item 13: this used to be reachable by any authenticated user -- now
  // requires the admin role (see requireRole(ROLES.ADMIN) in emergency.js).
  it('rejects a non-admin authenticated user with 403', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').set('Authorization', `Bearer ${token('BOLD-002')}`).send({ message: 'herkese haber' });
    expect(res.status).toBe(403);
    expect(app.locals.emitted).toEqual([]);
  });

  it('broadcasts via socket.io for an admin', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').set('Authorization', `Bearer ${adminToken('BOLD-002')}`).send({ message: 'herkese haber' });
    expect(res.status).toBe(200);
    expect(app.locals.emitted).toEqual([
      { event: 'emergency:broadcast', payload: expect.objectContaining({ from: 'BOLD-002', message: 'herkese haber' }) },
    ]);
  });

  it('rejects an empty message even when authenticated as admin', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').set('Authorization', `Bearer ${adminToken()}`).send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('also emails every registered user with an email on file, active or not', async () => {
    getUserEmailRecipientsMock.mockResolvedValue([
      { user_code: 'BOLD-003', nickname: 'BOLD-003', email: 'u3@example.com' },
      { user_code: 'BOLD-004', nickname: 'BOLD-004', email: 'u4@example.com' },
    ]);
    const app = buildApp();
    const res = await request(app).post('/api/emergency/users').set('Authorization', `Bearer ${adminToken('BOLD-002')}`).send({ message: 'herkese haber' });
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(sendEmergencyBroadcastEmailMock).toHaveBeenCalledWith(
      'BOLD-002',
      'herkese haber',
      [
        { user_code: 'BOLD-003', nickname: 'BOLD-003', email: 'u3@example.com' },
        { user_code: 'BOLD-004', nickname: 'BOLD-004', email: 'u4@example.com' },
      ]
    );
  });

  it('does not attempt to email anyone when no users have an email on file', async () => {
    getUserEmailRecipientsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).post('/api/emergency/users').set('Authorization', `Bearer ${adminToken()}`).send({ message: 'test' });
    await flushMicrotasks();
    expect(sendEmergencyBroadcastEmailMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/emergency/region (no auth required)', () => {
  it('sends a regional alert with no Authorization header', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/region').send({ message: 'bölgesel durum', region: 'Marmara' });
    expect(res.status).toBe(200);
    expect(sendEmergencyAlertMock).toHaveBeenCalledWith('ANONİM', 'bölgesel durum', 'Marmara');
  });

  it('rejects a missing message', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/emergency/region').send({ region: 'Ege' });
    expect(res.status).toBe(400);
  });
});
