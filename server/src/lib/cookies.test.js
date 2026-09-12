import { describe, it, expect, vi } from 'vitest';
import { setAuthCookie, clearAuthCookie, readCookie, readAuthCookie, AUTH_COOKIE_NAME } from './cookies.js';

describe('readCookie / readAuthCookie', () => {
  it('returns null for a missing header', () => {
    expect(readCookie(undefined, 'x')).toBeNull();
    expect(readAuthCookie(undefined)).toBeNull();
  });

  it('finds the named cookie among several', () => {
    expect(readCookie('a=1; bqi_jwt=abc.def.ghi; b=2', AUTH_COOKIE_NAME)).toBe('abc.def.ghi');
    expect(readAuthCookie('a=1; bqi_jwt=abc.def.ghi; b=2')).toBe('abc.def.ghi');
  });

  it('returns null when the named cookie is absent', () => {
    expect(readCookie('a=1; b=2', AUTH_COOKIE_NAME)).toBeNull();
  });

  it('URL-decodes the value', () => {
    expect(readCookie('bqi_jwt=a%2Fb', AUTH_COOKIE_NAME)).toBe('a/b');
  });
});

describe('setAuthCookie / clearAuthCookie', () => {
  it('sets the cookie httpOnly with SameSite=Lax and the given max-age', () => {
    const res = { cookie: vi.fn() };
    setAuthCookie(res, 'the-token', 12345);
    expect(res.cookie).toHaveBeenCalledWith(AUTH_COOKIE_NAME, 'the-token', expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12345,
      path: '/',
    }));
  });

  it('clears the cookie with matching attributes', () => {
    const res = { clearCookie: vi.fn() };
    clearAuthCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(AUTH_COOKIE_NAME, expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    }));
  });
});
