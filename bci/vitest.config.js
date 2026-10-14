import { defineConfig } from 'vitest/config';

const databaseUrl = process.env.BCI_DATABASE_URL || 'postgres://bci:bci@localhost:5432/bci_test';
const jwtSecret = process.env.BCI_JWT_SECRET || 'test-secret';

process.env.BCI_DATABASE_URL = databaseUrl;
process.env.BCI_JWT_SECRET = jwtSecret;
process.env.NODE_ENV = 'test';
process.env.BCI_ALLOW_UNSCOPED_TESTS='1';
process.env.LOG_LEVEL = 'silent';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**','test/providers/**'],
    globalSetup: ['test/globalSetup.js'],
    fileParallelism: false,
    // Native PostgreSQL migrations/truncation and actual browser proofs can
    // exceed Vitest's 5s default on Windows under concurrent IO load.
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      BCI_ALLOW_UNSCOPED_TESTS:'1',
      BCI_DATABASE_URL: databaseUrl,
      BCI_JWT_SECRET: jwtSecret,
      LOG_LEVEL: 'silent',
    },
  },
});
