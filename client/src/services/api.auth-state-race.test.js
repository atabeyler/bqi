import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_CHANGED_EVENT, getCurrentUser, setJWT, setLocalAuthUser } from './api.js';

function fakeJwt(payload) {
  const b64 = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  setLocalAuthUser(null);
  setJWT(null);
  await flushMicrotasks();
  delete window.bqiDesktop;
  delete window.bqiMobile;
});

describe('native auth state event ordering', () => {
  it('offline login publishes AUTH_CHANGED only after localAuthUser is available for an expired cached JWT', async () => {
    window.bqiDesktop = { cloudUrl: 'https://cloud.example.com' };
    const expiredJwt = fakeJwt({ userCode: 'U1', exp: Math.floor(Date.now() / 1000) - 3600 });
    const localUser = { userCode: 'U1', nickname: 'BOLD-001', isAdmin: false };
    const observed = [];
    const handler = () => observed.push(getCurrentUser());
    window.addEventListener(AUTH_CHANGED_EVENT, handler);

    try {
      // This is deliberately the real LoginPage order in v3.2.0:
      // setJWT() first, local fallback identity immediately afterward.
      // The event must not expose the half-written state in between.
      setJWT(expiredJwt);
      setLocalAuthUser(localUser);

      expect(observed).toEqual([]);
      await flushMicrotasks();
      expect(observed).toHaveLength(1);
      expect(observed[0]).toEqual(localUser);
    } finally {
      window.removeEventListener(AUTH_CHANGED_EVENT, handler);
    }
  });

  it('logout publishes AUTH_CHANGED only after both JWT and local fallback identity are cleared', async () => {
    window.bqiDesktop = { cloudUrl: 'https://cloud.example.com' };
    const freshJwt = fakeJwt({ userCode: 'U2', exp: Math.floor(Date.now() / 1000) + 3600 });
    setJWT(freshJwt);
    setLocalAuthUser({ userCode: 'U2', nickname: 'BOLD-002', isAdmin: false });
    await flushMicrotasks();

    const observed = [];
    const handler = () => observed.push(getCurrentUser());
    window.addEventListener(AUTH_CHANGED_EVENT, handler);

    try {
      // This mirrors DashboardPage's current order. Observers must not see
      // the old localAuthUser after the JWT has already been cleared.
      setJWT(null);
      setLocalAuthUser(null);

      expect(observed).toEqual([]);
      await flushMicrotasks();
      expect(observed).toEqual([null]);
    } finally {
      window.removeEventListener(AUTH_CHANGED_EVENT, handler);
    }
  });
});
