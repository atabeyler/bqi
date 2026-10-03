import { describe, it, expect, vi } from 'vitest';
import { startSelfPing } from './selfPing.js';

describe('selfPing', () => {
  it('does nothing outside Render, when switched off, or without fetch', () => {
    expect(startSelfPing({ env: {} })).toBeNull();
    expect(startSelfPing({ env: { RENDER_EXTERNAL_URL: 'https://x.onrender.com', SELF_PING: 'off' } })).toBeNull();
    expect(startSelfPing({ env: { RENDER_EXTERNAL_URL: 'https://x.onrender.com' }, fetchImpl: null })).toBeNull();
  });
  it('pings the public health url on a schedule, survives failures, and can be stopped', async () => {
    vi.useFakeTimers();
    const calls = []; let fail = false; const warn = vi.fn();
    const fetchImpl = vi.fn(async (url) => { calls.push(url); if (fail) throw new Error('boom'); return { ok: true }; });
    const p = startSelfPing({ env: { RENDER_EXTERNAL_URL: 'https://x.onrender.com/' }, fetchImpl, intervalMs: 1000, log: { warn } });
    expect(p.url).toBe('https://x.onrender.com/api/health');
    await vi.advanceTimersByTimeAsync(3100); expect(calls).toHaveLength(3); expect(new Set(calls)).toEqual(new Set(['https://x.onrender.com/api/health']));
    fail = true; await vi.advanceTimersByTimeAsync(1000); expect(warn).toHaveBeenCalledTimes(1);
    p.stop(); await vi.advanceTimersByTimeAsync(5000); expect(calls).toHaveLength(4);
    vi.useRealTimers();
  });
});
