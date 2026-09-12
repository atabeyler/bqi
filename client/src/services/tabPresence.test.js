import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startTabHeartbeat, stopTabHeartbeat, wasBrowserFullyClosedRecently } from './tabPresence.js';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  stopTabHeartbeat();
  vi.useRealTimers();
});

describe('tabPresence', () => {
  it('treats a browser with no recorded heartbeat as fully closed (first-ever visit or fully closed since)', () => {
    expect(wasBrowserFullyClosedRecently()).toBe(true);
  });

  it('is not "fully closed" right after a tab starts its heartbeat', () => {
    startTabHeartbeat();
    expect(wasBrowserFullyClosedRecently()).toBe(false);
  });

  it('keeps looking "open" as long as the heartbeat keeps ticking (refresh / another tab still alive)', () => {
    startTabHeartbeat();
    vi.advanceTimersByTime(20000);
    expect(wasBrowserFullyClosedRecently()).toBe(false);
  });

  it('is treated as fully closed once the heartbeat has gone stale for long enough', () => {
    startTabHeartbeat();
    stopTabHeartbeat();
    vi.advanceTimersByTime(30000);
    expect(wasBrowserFullyClosedRecently()).toBe(true);
  });
});
