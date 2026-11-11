import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Many tests open an in-process Postgres or start a child process. On a loaded machine the whole suite runs them
    // side by side and single tests passed the default 5 seconds without being any slower alone. A hang still fails.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
