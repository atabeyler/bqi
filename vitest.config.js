import { defineConfig } from 'vitest/config';

// Root-level config for desktop/ tests only — client/ and server/ each have
// their own independent vitest setup and are run via their own package.json
// scripts (npm test --prefix client / --prefix server).
export default defineConfig({
  test: {
    include: ['desktop/**/*.test.js'],
    environment: 'node',
  },
});
