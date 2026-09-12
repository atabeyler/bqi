import { describe, it, expect, vi } from 'vitest';
import { createConnectivityMonitor } from './connectivity.js';

describe('createConnectivityMonitor', () => {
  it('reports cloud when the health endpoint responds ok', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
    await monitor.checkOnce();
    expect(monitor.getState()).toBe('cloud');
  });

  it('reports local on network failure, without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
    await expect(monitor.checkOnce()).resolves.toBe(false);
    expect(monitor.getState()).toBe('local');
  });

  it('emits a change event only when the state actually changes', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
    const seen = [];
    monitor.onChange((s) => seen.push(s));

    await monitor.checkOnce();
    await monitor.checkOnce(); // still cloud -- no duplicate event
    expect(seen).toEqual(['cloud']);
  });

  it('markSyncing sets a transient sync state', () => {
    const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test' });
    monitor.markSyncing();
    expect(monitor.getState()).toBe('sync');
  });

  describe('onReconnect', () => {
    it('fires on a genuine local -> cloud transition', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true }));
      const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
      const reconnects = vi.fn();
      monitor.onReconnect(reconnects);

      expect(monitor.getState()).toBe('local'); // initial state, before any check
      await monitor.checkOnce(); // local -> cloud

      expect(reconnects).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire on a sync -> cloud settling step (regression: this previously caused an infinite sync loop)', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true }));
      const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
      const reconnects = vi.fn();
      monitor.onReconnect(reconnects);

      await monitor.checkOnce(); // local -> cloud (1st, real reconnect)
      expect(reconnects).toHaveBeenCalledTimes(1);

      // Simulates performSync()'s own markSyncing() + checkOnce() sequence,
      // which main.js runs on every sync pass (including ones triggered by
      // onReconnect itself) -- this must never re-trigger onReconnect, or
      // the reconnect handler and performSync() call each other forever.
      monitor.markSyncing(); // cloud -> sync
      await monitor.checkOnce(); // sync -> cloud

      expect(reconnects).toHaveBeenCalledTimes(1); // still just the one real reconnect
    });

    it('does not fire while remaining offline', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND'); });
      const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
      const reconnects = vi.fn();
      monitor.onReconnect(reconnects);

      await monitor.checkOnce();
      await monitor.checkOnce();

      expect(reconnects).not.toHaveBeenCalled();
    });

    it('fires again on a second genuine reconnect after going back offline', async () => {
      let online = true;
      const fetchImpl = vi.fn(async () => {
        if (!online) throw new Error('ENOTFOUND');
        return { ok: true };
      });
      const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
      const reconnects = vi.fn();
      monitor.onReconnect(reconnects);

      await monitor.checkOnce(); // local -> cloud
      online = false;
      await monitor.checkOnce(); // cloud -> local
      online = true;
      await monitor.checkOnce(); // local -> cloud again

      expect(reconnects).toHaveBeenCalledTimes(2);
    });

    it('returns an unsubscribe function, like onChange', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true }));
      const monitor = createConnectivityMonitor({ apiBaseUrl: 'https://api.test', fetchImpl });
      const reconnects = vi.fn();
      const unsubscribe = monitor.onReconnect(reconnects);
      unsubscribe();

      await monitor.checkOnce();
      expect(reconnects).not.toHaveBeenCalled();
    });
  });
});
