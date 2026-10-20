// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Playwright configuration for the Cloud acceptance suite (ADR-0095).
//
// The existing suite (playwright.config.ts) runs against a SQLite
// instance booted by Playwright itself, with the worker and the scheduler
// disabled: it proves the SPA. This configuration runs against the
// acceptance stack instead — PostgreSQL with RLS, Redis, and the three
// Cloud processes — and therefore proves the SPA against the Cloud data
// model: two tenants, one of them on a paid plan.
//
// There is no webServer here on purpose: the stack is started, migrated
// and seeded by scripts/acceptance/cloud-acceptance.mjs, which runs this
// project as its last phase. Starting a second server would be a second
// topology, and the point of the suite is that there is exactly one.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ACCEPTANCE_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e/cloud',
  globalSetup: './e2e/cloud/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    // The responseCache middleware serves GET responses with
    // `Cache-Control: private, max-age=60`; without this the browser
    // could show the previous tenant's data after a switch.
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'cloud', use: { ...devices['Desktop Chrome'] } }],
});
