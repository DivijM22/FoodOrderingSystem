import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file boots its own in-memory MongoDB replica set.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
