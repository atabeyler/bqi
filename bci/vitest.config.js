import { defineConfig } from 'vitest/config';

const databaseUrl = process.env.BCI_DATABASE_URL || 'postgres://bci:bci@localhost:5432/bci_test';
const jwtSecret = process.env.BCI_JWT_SECRET || 'test-secret';

process.env.BCI_DATABASE_URL = databaseUrl;
process.env.BCI_JWT_SECRET = jwtSecret;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    globalSetup: ['test/globalSetup.js'],
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      BCI_DATABASE_URL: databaseUrl,
      BCI_JWT_SECRET: jwtSecret,
      LOG_LEVEL: 'silent',
    },
  },
});
