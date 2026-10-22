import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests run ONLY against the local Supabase stack (`pnpm db:start`). They create and delete
// shops, users and orders and run `tenant:seed`, so a remote SUPABASE_URL in the shell (e.g. the hosted
// project) is refused before any test starts. tests/integration/helpers.ts re-checks the resolved URL.
const remoteUrl = process.env.SUPABASE_URL;
if (remoteUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(remoteUrl)) {
  throw new Error(`Integration tests run only against local Supabase; unset SUPABASE_URL (got ${remoteUrl})`);
}

export default defineConfig({
  // Lets integration tests import storefront modules (they use the `@/` alias) and exercise the
  // exact queries the browser sends.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Suites create isolated tenants, but run files sequentially to keep the local stack calm.
    fileParallelism: false,
  },
});
