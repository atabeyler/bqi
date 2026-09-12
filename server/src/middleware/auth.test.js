import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const mockQuery = vi.fn(async () => ({ rows: [{ blocked: false }] }));
vi.mock('../services/database.js', () => ({
  query: (...args) => mockQuery(...args),
}));

const { authMiddleware } = await import('./auth.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');

function fakeRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockImplementation(async () => ({ rows: [{ blocked: false }] }));
  });

  it('401s with neither a cookie nor an Authorization header', async () => {
    const req = { headers: {} };
    const res = fakeRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates via the Authorization header (desktop/mobile path)', async () => {
    const token = jwt.sign({ userCode: 'U1', nickname: 'BOLD-001' }, JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = fakeRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.userCode).toBe('U1');
    expect(req.token).toBe(token);
  });

  it('authenticates via the httpOnly session cookie (web path)', async () => {
    const token = jwt.sign({ userCode: 'U2', nickname: 'BOLD-002' }, JWT_SECRET);
    const req = { headers: { cookie: `other=1; bqi_jwt=${token}; more=2` } };
    const res = fakeRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.userCode).toBe('U2');
    expect(req.token).toBe(token);
  });

  it('401s for an invalid/forged token from either source', async () => {
    const forged = jwt.sign({ userCode: 'X' }, 'wrong-secret');
    const res = fakeRes();
    await authMiddleware({ headers: { authorization: `Bearer ${forged}` } }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);

    const res2 = fakeRes();
    await authMiddleware({ headers: { cookie: `bqi_jwt=${forged}` } }, res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(401);
  });

  it('prefers the cookie when both are present', async () => {
    const cookieToken = jwt.sign({ userCode: 'FROM-COOKIE' }, JWT_SECRET);
    const headerToken = jwt.sign({ userCode: 'FROM-HEADER' }, JWT_SECRET);
    const req = { headers: { cookie: `bqi_jwt=${cookieToken}`, authorization: `Bearer ${headerToken}` } };
    const res = fakeRes();
    await authMiddleware(req, res, vi.fn());
    expect(req.user.userCode).toBe('FROM-COOKIE');
  });

  // P1 fix: a token issued while the account was active must stop working
  // once the account is blocked, without waiting for the token to expire.
  describe('blocked-user re-check', () => {
    it('403s a valid, unexpired token whose account is now blocked in the DB', async () => {
      mockQuery.mockImplementation(async () => ({ rows: [{ blocked: true }] }));
      const token = jwt.sign({ userCode: 'BLOCKED-USER', nickname: 'BOLD-BLOCKED' }, JWT_SECRET, { expiresIn: '2h' });
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = fakeRes();
      const next = vi.fn();
      await authMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('leaves a non-blocked user unaffected', async () => {
      mockQuery.mockImplementation(async () => ({ rows: [{ blocked: false }] }));
      const token = jwt.sign({ userCode: 'ACTIVE-USER', nickname: 'BOLD-ACTIVE' }, JWT_SECRET, { expiresIn: '2h' });
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = fakeRes();
      const next = vi.fn();
      await authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user.userCode).toBe('ACTIVE-USER');
    });

    it('caches the blocked-status lookup so a tight loop of requests does not hit the DB every time', async () => {
      const token = jwt.sign({ userCode: 'CACHE-USER', nickname: 'BOLD-CACHE' }, JWT_SECRET, { expiresIn: '2h' });
      for (let i = 0; i < 20; i++) {
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = fakeRes();
        const next = vi.fn();
        await authMiddleware(req, res, next);
        expect(next).toHaveBeenCalled();
      }
      // 20 requests for the same user within the TTL window should collapse
      // to a single DB lookup, not 20.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
