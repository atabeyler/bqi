import { describe, it, expect, beforeEach } from 'vitest';

// REDIS_URL is not set (default in CI/test environments) — exercises the memory fallback.
delete process.env.REDIS_URL;

import * as onlineState from './onlineState.js';

describe('onlineState (memory fallback, REDIS_URL unset)', () => {
  beforeEach(async () => {
    for (const n of ['TEST-A', 'TEST-B']) {
      await onlineState.removeOnline(n);
      await onlineState.removeLocation(n);
    }
  });

  it('can add and list a user', async () => {
    await onlineState.setOnline('TEST-A', 'socket-1');
    const names = await onlineState.getOnlineNicknames();
    expect(names).toContain('TEST-A');
    expect(await onlineState.getOnlineSocketId('TEST-A')).toBe('socket-1');
  });

  it('removes a user from the list once removed', async () => {
    await onlineState.setOnline('TEST-B', 'socket-2');
    await onlineState.removeOnline('TEST-B');
    expect(await onlineState.getOnlineNicknames()).not.toContain('TEST-B');
    expect(await onlineState.getOnlineSocketId('TEST-B')).toBeUndefined();
  });

  it('can save, read, and remove a location', async () => {
    await onlineState.setLocation('TEST-A', { lat: 41, lng: 29, city: 'Istanbul', updatedAt: 123 });
    const all = await onlineState.getAllLocations();
    expect(all['TEST-A']).toEqual({ lat: 41, lng: 29, city: 'Istanbul', updatedAt: 123 });

    await onlineState.removeLocation('TEST-A');
    expect((await onlineState.getAllLocations())['TEST-A']).toBeUndefined();
  });

  it('reports a new conversation on the first from->to message, then not again until idle', async () => {
    expect(await onlineState.isNewDirectMessageConversation('TEST-A', 'TEST-B')).toBe(true);
    expect(await onlineState.isNewDirectMessageConversation('TEST-A', 'TEST-B')).toBe(false);
  });

  it('tracks each direction of a conversation independently', async () => {
    expect(await onlineState.isNewDirectMessageConversation('TEST-C', 'TEST-D')).toBe(true);
    expect(await onlineState.isNewDirectMessageConversation('TEST-D', 'TEST-C')).toBe(true);
  });
});
