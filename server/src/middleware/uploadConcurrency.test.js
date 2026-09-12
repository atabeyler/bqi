import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { uploadConcurrencyGate, getUploadConcurrencyStatus } from './uploadConcurrency.js';

function fakeRes() {
  const res = new EventEmitter();
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe('uploadConcurrencyGate', () => {
  it('lets requests through under the cap and releases the slot when the response finishes', () => {
    const res = fakeRes();
    const next = vi.fn();
    uploadConcurrencyGate({}, res, next);
    expect(next).toHaveBeenCalled();
    expect(getUploadConcurrencyStatus().active).toBeGreaterThan(0);
    res.emit('finish');
    expect(getUploadConcurrencyStatus().active).toBe(0);
  });

  it('rejects with 503 once the concurrency cap is reached', () => {
    const { maxConcurrency } = getUploadConcurrencyStatus();
    const responses = [];
    for (let i = 0; i < maxConcurrency; i++) {
      const res = fakeRes();
      uploadConcurrencyGate({}, res, vi.fn());
      responses.push(res);
    }

    const overflowRes = fakeRes();
    const overflowNext = vi.fn();
    uploadConcurrencyGate({}, overflowRes, overflowNext);
    expect(overflowNext).not.toHaveBeenCalled();
    expect(overflowRes.status).toHaveBeenCalledWith(503);

    // Release every slot we took so this test doesn't leak state into others.
    responses.forEach((res) => res.emit('finish'));
    expect(getUploadConcurrencyStatus().active).toBe(0);
  });
});
