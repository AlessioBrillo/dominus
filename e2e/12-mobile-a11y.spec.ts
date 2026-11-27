// SPDX-License-Identifier: AGPL-3.0-only
// WCAG 2.1 AA on the phone shell itself. 09-a11y.spec.ts scans the desktop
// viewport; the bottom tab bar and the card layouts exist only at phone width
// and must not regress silently (ADR-0114).
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { E2E_API_KEY, login } from './utils';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} - ${violation.nodes.length} node(s)`,
    );
}

test.describe('mobile accessibility (WCAG 2.1 AA)', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('dominus_theme', 'dark'));
    await login(page);
    await request.patch('/api/v1/onboarding/state', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
      data: { currentStep: 'complete' },
    });
  });

  for (const [name, path, heading] of [
    ['today', '/', /dashboard/i],
    ['holdings', '/portfolio', /portfolio/i],
    ['alerts', '/alerts', /alerts/i],
    ['account', '/account', /account/i],
  ] as const) {
    test(`${name} has no serious violations at phone width`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      expect(await scan(page)).toEqual([]);
    });
  }
});
