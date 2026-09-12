import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { getOptionalUserCode } from './optionalAuth.js';
import { JWT_SECRET } from './jwtSecret.js';

describe('getOptionalUserCode', () => {
  it('returns ANONİM when there is no Authorization header', () => {
    expect(getOptionalUserCode({ headers: {} })).toBe('ANONİM');
  });

  it('returns ANONİM for a malformed Authorization header', () => {
    expect(getOptionalUserCode({ headers: { authorization: 'not-a-bearer-token' } })).toBe('ANONİM');
  });

  it('returns ANONİM for an invalid/forged token', () => {
    const fake = jwt.sign({ userCode: 'X' }, 'wrong-secret');
    expect(getOptionalUserCode({ headers: { authorization: `Bearer ${fake}` } })).toBe('ANONİM');
  });

  it('returns the userCode from a validly signed token', () => {
    const token = jwt.sign({ userCode: 'BOLD-001' }, JWT_SECRET);
    expect(getOptionalUserCode({ headers: { authorization: `Bearer ${token}` } })).toBe('BOLD-001');
  });

  it('returns the userCode from a session cookie when there is no Authorization header (web path)', () => {
    const token = jwt.sign({ userCode: 'BOLD-002' }, JWT_SECRET);
    expect(getOptionalUserCode({ headers: { cookie: `bqi_jwt=${token}` } })).toBe('BOLD-002');
  });

  it('prefers the cookie over a stale/mismatched Authorization header', () => {
    const cookieToken = jwt.sign({ userCode: 'FROM-COOKIE' }, JWT_SECRET);
    const headerToken = jwt.sign({ userCode: 'FROM-HEADER' }, JWT_SECRET);
    expect(getOptionalUserCode({ headers: { cookie: `bqi_jwt=${cookieToken}`, authorization: `Bearer ${headerToken}` } })).toBe('FROM-COOKIE');
  });
});
