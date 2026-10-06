import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The replay tests set their own, much longer, timeouts.
    testTimeout: 10_000,
  },
});
