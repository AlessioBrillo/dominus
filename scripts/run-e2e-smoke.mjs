#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End-to-end smoke gate.
 *
 * The full Playwright suite lives in CI (`.github/workflows/ci.yml`). It was
 * not part of the local gate, and that gap had a cost: the suite went red on
 * `master` and stayed red while the local gate stayed green, because the
 * drift it caught (two tables rendering the same domain names) was invisible
 * to everything the local gate ran.
 *
 * This script runs the subset that covers the regressions that actually
 * happen in practice — the authentication path, the portfolio table (the
 * strict-mode drift) and the accessibility gate — so the local gate cannot
 * be green while the shipped SPA is broken.
 *
 * It is deliberately fail-closed:
 *
 *   - the browser must be installed (`npm run e2e:install`), otherwise the
 *     step fails with the exact command to run, instead of silently
 *     skipping the check;
 *   - the SPA must be built, because the E2E server serves `dist/web`;
 *   - `SKIP_E2E_SMOKE=1` is the only way out, and it prints a warning that
 *     is meant to be impossible to miss in a CI log.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The smoke subset. Each entry earns its place by covering a surface that
 * has broken before, or that would break silently:
 *
 *   - 01-auth: the login path every other flow depends on;
 *   - 04-portfolio: the portfolio table (strict-mode drift, ADR-0083 M5);
 *   - 09-a11y: the WCAG 2.1 AA gate over the main screens.
 */
const SMOKE_SPECS = ['e2e/01-auth.spec.ts', 'e2e/04-portfolio.spec.ts', 'e2e/09-a11y.spec.ts'];

function fail(message) {
  console.error(`e2e-smoke: FAILED — ${message}`);
  process.exit(1);
}

if (process.env.SKIP_E2E_SMOKE === '1') {
  console.warn(
    'e2e-smoke: SKIPPED by SKIP_E2E_SMOKE=1. The end-to-end smoke gate did not ' +
      'run. This escape hatch exists for environments without a browser; it is ' +
      'not a way to merge an unverified SPA.',
  );
  process.exit(0);
}

/* 1. Backend build must exist — the E2E server runs the compiled app. */
if (!existsSync(join(root, 'dist', 'index.js'))) {
  fail('dist/index.js is missing. Run `npm run build` before the E2E smoke gate.');
}

/* 2. Frontend build must exist and must be staged into dist/web. */
if (!existsSync(join(root, 'frontend', 'dist'))) {
  fail(
    'frontend/dist is missing. Run `npm run build:frontend` before the E2E smoke gate.',
  );
}
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'finalize-dist.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  fail('finalize-dist.mjs failed — the built SPA could not be staged into dist/web.');
}

/* 3. The Chromium build must be present. */
let chromiumPath;
try {
  const { chromium } = await import('@playwright/test');
  chromiumPath = chromium.executablePath();
} catch {
  fail('@playwright/test is not installed. Run `npm ci` first.');
}
if (!chromiumPath || !existsSync(chromiumPath)) {
  fail(
    'the Playwright Chromium build is missing. Run `npm run e2e:install` ' +
      '(it downloads the browser once) and run the gate again.',
  );
}

/* 4. Run the smoke subset. */
console.log(`e2e-smoke: running ${SMOKE_SPECS.join(', ')}`);
const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test',
    ...SMOKE_SPECS,
    '--project=chromium',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, CI: process.env.CI ?? '1' } },
);

if (result.error) fail(`could not start Playwright: ${result.error.message}`);
if (result.status !== 0) {
  console.error(`e2e-smoke: FAILED — Playwright exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log('e2e-smoke: OK');
