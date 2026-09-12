import { describe, it, expect } from 'vitest';
import { validateEnv } from '../src/lib/validateEnv.js';

describe('validateEnv', () => {
  it('passes in development even without BCI_DATABASE_URL', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('fails closed in production when BCI_DATABASE_URL is missing', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', BCI_JWT_SECRET: 'secret' })
    ).toThrow(/BCI_DATABASE_URL/);
  });

  it('fails closed in production when BCI_JWT_SECRET is missing', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', BCI_DATABASE_URL: 'postgres://x' })
    ).toThrow(/BCI_JWT_SECRET/);
  });

  it('passes in production when required vars are present', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', BCI_DATABASE_URL: 'postgres://x', BCI_JWT_SECRET: 'secret' })
    ).not.toThrow();
  });

  it('rejects an unknown engine health execution mode', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', BCI_ENGINE_HEALTH_MODE: 'API_CONTAINER' }))
      .toThrow(/BCI_ENGINE_HEALTH_MODE/);
    expect(() => validateEnv({ NODE_ENV: 'development', BCI_ENGINE_HEALTH_MODE: 'WORKER' }))
      .not.toThrow();
  });
});
