// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests run against the compiled backend (`node dist/index.js`),
// which serves the built SPA from frontend/dist. The webServer boots on a
// fresh SQLite database in .e2e/ (wiped as part of the startup command) and
// the globalSetup seeds deterministic fixtures. No external services are
// required; the worker and scheduler are disabled.
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // The responseCache middleware sets `Cache-Control: private, max-age=60`
    // on GET responses, which would make the browser serve stale onboarding /
    // portfolio state right after a spec mutates it via the API. Force
    // revalidation so the SPA always observes fresh server state.
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/e2e-wipe.mjs && node dist/index.js',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: './.e2e/dominus-e2e.db',
      API_KEYS: 'admin=sk-e2e-test-key',
      WORKER_ENABLED: 'false',
      SCHEDULER_ENABLED: 'false',
      // The suite performs hundreds of API calls in seconds; disable the
      // general API rate limiters (guarded by RATE_LIMIT_MAX > 0). Config
      // validation only allows 0 under NODE_ENV=development.
      NODE_ENV: 'development',
      RATE_LIMIT_MAX: '0',
      LOG_LEVEL: 'warn',
      FRONTEND_DIST_PATH: './frontend/dist',
    },
  },
});