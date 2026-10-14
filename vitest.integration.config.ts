import { defineConfig } from 'vitest/config';

// Integration tests run against a real Supabase stack (local by default: `pnpm db:start`).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Suites create isolated tenants, but run files sequentially to keep the local stack calm.
    fileParallelism: false,
  },
});
