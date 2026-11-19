import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
    // Collector failures are logged on purpose; keep test output readable.
    env: { TOKENGATOR_LOG: 'error' }
  }
});
