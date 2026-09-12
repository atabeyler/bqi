import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getToken, setJWT, setLocalAuthUser, getCurrentUser, resolveCurrentUser, logoutRequest, hydrateNativeSession, api } from './api.js';

// Simulates a fetch Response whose body streams the given raw chunks
// (as they'd arrive over the wire, including the server's NUL-delimited
// completion markers -- see aiGenerate.ts's STREAM_END_MARKER/STREAM_ERROR_MARKER).
function streamedResponse(chunks, headers = {}) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[i++]) };
        },
      }),
    },
  };
}

function fakeJwtWithPayload(payload) {
  const b64 = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('api.js session handling', () => {
  afterEach(() => {
    // nativeJwt is module-private in-memory state (see api.js's setJWT
    // comment for why it's no longer localStorage) -- must be cleared
    // while isNativeShell() can still see window.bqiDesktop/Mobile
    // (setJWT's native branch is a no-op once those are gone), so this
    // runs BEFORE deleting them below.
    setJWT(null);
    setLocalAuthUser(null);
    localStorage.clear();
    delete window.bqiDesktop;
    delete window.bqiMobile;
    vi.unstubAllGlobals();
  });

  describe('on the web (no native shell)', () => {
    it('getToken()/getCurrentUser() never read localStorage -- the session lives only in the httpOnly cookie', () => {
      localStorage.setItem('bqi_jwt', fakeJwtWithPayload({ userCode: 'X', exp: Math.floor(Date.now() / 1000) + 3600 }));
      expect(getToken()).toBeNull();
      expect(getCurrentUser()).toBeNull();
    });

    it('setJWT() never writes to localStorage', () => {
      setJWT('some-token');
      expect(localStorage.getItem('bqi_jwt')).toBeNull();
    });

    it('resolveCurrentUser() calls GET /api/auth/me and returns its payload', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ userCode: 'U1', nickname: 'BOLD-001', isAdmin: false }) }));
      vi.stubGlobal('fetch', fetchMock);

      const user = await resolveCurrentUser();
      expect(user).toEqual({ userCode: 'U1', nickname: 'BOLD-001', isAdmin: false });
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/me'), expect.objectContaining({ credentials: 'include' }));
    });

    it('resolveCurrentUser() returns null when the server says unauthenticated', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Yetkisiz' }) })));
      expect(await resolveCurrentUser()).toBeNull();
    });

    it('logoutRequest() posts to /api/auth/logout and never throws even if it fails', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(logoutRequest()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/logout'), expect.objectContaining({ method: 'POST' }));

      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
      await expect(logoutRequest()).resolves.toBeUndefined();
    });

    it('req() sends credentials: include so the session cookie rides along', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await api.getAIStatus();
      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'include' }));
      // No Authorization header -- getJWT() is null on web, nothing to attach.
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
  });

  describe('on desktop/mobile (native shell)', () => {
    beforeEach(() => {
      window.bqiDesktop = { cloudUrl: 'https://cloud.example.com' };
    });

    it('getToken()/getCurrentUser() read the in-memory JWT set via setJWT(), never localStorage', () => {
      const token = fakeJwtWithPayload({ userCode: 'D1', nickname: 'BOLD-D1', exp: Math.floor(Date.now() / 1000) + 3600 });
      setJWT(token);
      expect(getToken()).toBe(token);
      expect(getCurrentUser()).toMatchObject({ userCode: 'D1', nickname: 'BOLD-D1' });
      // The AQ security-review fix this test guards: no plaintext copy on disk.
      expect(localStorage.getItem('bqi_jwt')).toBeNull();
    });

    it('setJWT() never writes to localStorage (in-memory only now)', () => {
      setJWT('native-token');
      expect(getToken()).toBe('native-token');
      expect(localStorage.getItem('bqi_jwt')).toBeNull();
      setJWT(null);
      expect(getToken()).toBeNull();
    });

    it('resolveCurrentUser() resolves synchronously from the in-memory JWT without a network call', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      setJWT(fakeJwtWithPayload({ userCode: 'D2', exp: Math.floor(Date.now() / 1000) + 3600 }));

      const user = await resolveCurrentUser();
      expect(user).toMatchObject({ userCode: 'D2' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('hydrateNativeSession() restores the in-memory JWT from the platform secure-session getter at startup', async () => {
      const token = fakeJwtWithPayload({ userCode: 'D3', exp: Math.floor(Date.now() / 1000) + 3600 });
      const getSessionFn = vi.fn(async () => ({ jwt: token, userCode: 'D3' }));

      expect(getToken()).toBeNull();
      await hydrateNativeSession(getSessionFn);
      expect(getSessionFn).toHaveBeenCalledTimes(1);
      expect(getToken()).toBe(token);
    });

    it('hydrateNativeSession() is a no-op when there is no stored session, instead of throwing', async () => {
      await expect(hydrateNativeSession(async () => null)).resolves.toBeUndefined();
      expect(getToken()).toBeNull();
      await expect(hydrateNativeSession(async () => { throw new Error('secureStore unavailable'); })).resolves.toBeUndefined();
      expect(getToken()).toBeNull();
    });

    // Offline authentication (LoginPage.jsx's attemptOfflineLogin(), which
    // calls setLocalAuthUser()) is not the same thing as cloud bearer-token
    // authorization -- an expired cached jwt from a stale offline login must
    // not also kick the user out of local-only usage.
    it('getCurrentUser() falls back to the local-auth identity when the native jwt is expired, instead of self-clearing', () => {
      const expiredToken = fakeJwtWithPayload({ userCode: 'D4', exp: Math.floor(Date.now() / 1000) - 3600 });
      setJWT(expiredToken);
      setLocalAuthUser({ userCode: 'D4', nickname: 'BOLD-D4', isAdmin: false });

      expect(getCurrentUser()).toEqual({ userCode: 'D4', nickname: 'BOLD-D4', isAdmin: false });
      // The stale jwt itself is left in place -- only the return value falls
      // back, this call must not have self-cleared it.
      expect(getToken()).toBe(expiredToken);
    });

    it('getCurrentUser() still self-clears and returns null on an expired jwt when there is no local-auth identity to fall back on', () => {
      const expiredToken = fakeJwtWithPayload({ userCode: 'D5', exp: Math.floor(Date.now() / 1000) - 3600 });
      setJWT(expiredToken);

      expect(getCurrentUser()).toBeNull();
      expect(getToken()).toBeNull();
    });
  });
});

// item 18: the client must be able to tell a normal stream finish apart
// from a mid-answer cutoff, using the NUL-delimited marker the server
// appends as its very last write (aiGenerate.ts's streamConsultationText).
describe('api.chatConsult streaming completion signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports complete: true and strips the marker when the stream ends normally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(
      ['Merhaba', ' dünya', ' BQI_STREAM_END '],
      { 'content-type': 'text/plain', 'x-ai-provider': encodeURIComponent('Q CLOUD') }
    )));

    const chunks = [];
    const result = await api.chatConsult('hi', [], null, null, (chunk) => chunks.push(chunk));

    expect(result.content).toBe('Merhaba dünya');
    expect(result.complete).toBe(true);
    expect(chunks.join('')).toBe('Merhaba dünya');
  });

  it('reports complete: false and strips the marker when a provider errors mid-stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(
      ['Yarım cev', 'ap', ' BQI_STREAM_ERROR '],
      { 'content-type': 'text/plain' }
    )));

    const result = await api.chatConsult('hi', [], null, null, () => {});

    expect(result.content).toBe('Yarım cevap');
    expect(result.complete).toBe(false);
  });

  it('reports complete: false when the stream ends with no marker at all (e.g. a dropped connection)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(
      ['kesildi'],
      { 'content-type': 'text/plain' }
    )));

    const result = await api.chatConsult('hi', [], null, null, () => {});

    expect(result.content).toBe('kesildi');
    expect(result.complete).toBe(false);
  });
});
