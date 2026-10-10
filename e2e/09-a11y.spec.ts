// SPDX-License-Identifier: AGPL-3.0-only
// Accessibility gate (WCAG 2.1 AA). axe-core scans the main flows of the real
// SPA served by the compiled backend and fails on serious/critical findings.
// Lower-impact findings are logged in the test output rather than failing CI,
// so the gate stays stable while still surfacing regressions early.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { E2E_API_KEY, login } from './utils';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page): Promise<{ blocking: string[]; advisory: string[] }> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const describe = (v: (typeof violations)[number]): string =>
    `${v.id} (${v.impact}): ${v.help} - ${v.nodes.length} node(s)\n` +
    v.nodes
      .slice(0, 4)
      .map((n) => `      ${n.target.join(' ')}: ${n.any[0]?.message ?? n.failureSummary ?? ''}`)
      .join('\n');
  return {
    blocking: violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(describe),
    advisory: violations
      .filter((v) => v.impact !== 'serious' && v.impact !== 'critical')
      .map(describe),
  };
}

test.describe('accessibility (WCAG 2.1 AA)', () => {
  test('login screen', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('API Key').waitFor({ state: 'visible' });
    const { blocking, advisory } = await scan(page);
    if (advisory.length) console.log(`[a11y advisory] login:\n  ${advisory.join('\n  ')}`);
    expect(blocking).toEqual([]);
  });

  test.describe('dark theme', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('dominus_theme', 'dark'));
    });

    test('login screen', async ({ page }) => {
      await page.goto('/');
      await page.getByPlaceholder('API Key').waitFor({ state: 'visible' });
      expect((await scan(page)).blocking).toEqual([]);
    });

    for (const [name, path] of [
      ['dashboard', '/'],
      ['portfolio', '/portfolio'],
      ['team', '/team'],
    ] as const) {
      test(`${name} page`, async ({ page, request }) => {
        await login(page);
        await request.patch('/api/v1/onboarding/state', {
          headers: { Authorization: `Bearer ${E2E_API_KEY}` },
          data: { currentStep: 'complete' },
        });
        await page.goto(path);
        await expect(page.locator('html.dark')).toHaveCount(1);
        await expect(page.getByRole('heading').first()).toBeVisible();
        expect((await scan(page)).blocking).toEqual([]);
      });
    }
  });

  test.describe('signed in', () => {
    test.beforeEach(async ({ page, request }) => {
      await login(page);
      // Keep the dashboard from redirecting into the onboarding wizard.
      await request.patch('/api/v1/onboarding/state', {
        headers: { Authorization: `Bearer ${E2E_API_KEY}` },
        data: { currentStep: 'complete' },
      });
    });

    const routes: Array<[name: string, path: string, heading: RegExp]> = [
      ['dashboard', '/', /dashboard/i],
      ['candidates', '/candidates', /candidates/i],
      ['portfolio', '/portfolio', /portfolio/i],
      ['team', '/team', /^team$/i],
      ['billing', '/billing', /billing/i],
      ['settings', '/settings', /settings/i],
    ];

    for (const [name, path, heading] of routes) {
      test(`${name} page has no serious violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
        const { blocking, advisory } = await scan(page);
        if (advisory.length) console.log(`[a11y advisory] ${name}:\n  ${advisory.join('\n  ')}`);
        expect(blocking).toEqual([]);
      });
    }
  });
});
