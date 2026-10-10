// SPDX-License-Identifier: AGPL-3.0-only
// Regenerates the README screenshots from the deterministic E2E fixtures:
//
//   npm run build && (cd frontend && npm run build)
//   CAPTURE_SCREENSHOTS=1 npx playwright test e2e/10-screenshots.spec.ts
//
// Skipped otherwise, so normal CI runs never rewrite files in docs/assets.
import { test } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

const OUT = 'docs/assets';

test.describe('README screenshots', () => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, 'set CAPTURE_SCREENSHOTS=1 to regenerate');

  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('dominus_theme', 'dark'));
    await login(page);
    await request.patch('/api/v1/onboarding/state', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
      data: { currentStep: 'complete' },
    });
  });

  for (const [name, path, heading] of [
    ['dashboard', '/', /dashboard/i],
    ['candidates', '/candidates', /candidates/i],
    ['portfolio', '/portfolio', /portfolio/i],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await page.getByRole('heading', { name: heading }).first().waitFor();
      // Let charts and tables settle.
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${OUT}/${name}.png` });
    });
  }
});
