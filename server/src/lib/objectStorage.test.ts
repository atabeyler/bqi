import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isS3Configured } from './objectStorage.js';

describe('isS3Configured', () => {
  const keys = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) { original[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('returns false when none of the three are set', () => {
    expect(isS3Configured()).toBe(false);
  });

  it('returns false when only some are set', () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_ACCESS_KEY_ID = 'k';
    expect(isS3Configured()).toBe(false);
  });

  it('returns true when all three are set', () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_ACCESS_KEY_ID = 'k';
    process.env.S3_SECRET_ACCESS_KEY = 's';
    expect(isS3Configured()).toBe(true);
  });
});
