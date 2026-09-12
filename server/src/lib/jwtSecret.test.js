import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('JWT_SECRET', () => {
  it('uses JWT_SECRET from the environment when set', async () => {
    vi.resetModules();
    process.env.JWT_SECRET = 'my-real-secret';
    const { JWT_SECRET } = await import('./jwtSecret.js');
    expect(JWT_SECRET).toBe('my-real-secret');
  });

  it('falls back to a random per-process secret outside production when unset', async () => {
    vi.resetModules();
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'test';
    const { JWT_SECRET } = await import('./jwtSecret.js');
    expect(JWT_SECRET).not.toBe('change-me-in-production');
    expect(JWT_SECRET.length).toBeGreaterThan(10);
  });

  it('throws at import time when unset in production instead of silently defaulting', async () => {
    vi.resetModules();
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    await expect(import('./jwtSecret.js')).rejects.toThrow();
  });
});
