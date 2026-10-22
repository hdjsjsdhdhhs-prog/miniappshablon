import { defineConfig, devices } from '@playwright/test';
import { assertLocalSupabaseEnv } from './scripts/lib/local-supabase-guard.ts';

// E2E runs against the LOCAL Supabase stack (pnpm db:start) and a dedicated Vite dev server.
// Seed, publish and owner accounts write data, so a hosted or ambiguous Supabase environment is refused
// here, before the web server or global setup start (global-setup.ts re-checks the resolved URL and the
// URL the running dev server injects into the app).
assertLocalSupabaseEnv();

// Own port, never reused: an unrelated server (e.g. `pnpm dev` with hosted VITE_* values from .env.local)
// on this port makes Playwright fail instead of testing against it.
const E2E_PORT = 5183;
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: {
    // dev:local passes the local stack's URL and anon key via process env (overrides .env files).
    command: `pnpm dev:local --port ${E2E_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
