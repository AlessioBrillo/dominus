// SPDX-License-Identifier: AGPL-3.0-only
// Runs before the dashboard spec (numbered 03 < 05). The beforeEach resets
// the wizard to the welcome step via the API so the spec is order-independent
// and safe across retries.
import { test, expect } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

test.describe('onboarding', () => {
  test.beforeEach(async ({ page, request }) => {
    await login(page);
    const res = await request.patch('/api/v1/onboarding/state', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
      data: { currentStep: 'welcome' },
    });
    if (!res.ok()) {
      throw new Error(`failed to reset onboarding state: ${res.status()} ${await res.text()}`);
    }
  });

  test('a fresh install redirects to the three-step activation wizard', async ({ page }) => {
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();
    await expect(page.getByText('Score, import and set alerts in 3 steps')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Score a domain' })).toBeVisible();
    await expect(page.getByRole('button', { name: /skip setup/i })).toHaveCount(0);
  });

  test('the sample fallback unlocks the import step', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Score a domain' })).toBeVisible();

    await page.getByRole('button', { name: /use sample data instead/i }).click();
    await expect(page.getByRole('button', { name: /next: import portfolio/i })).toBeEnabled();
    await page.getByRole('button', { name: /next: import portfolio/i }).click();
    await expect(page.getByRole('heading', { name: 'Import your portfolio' })).toBeVisible();

    // The final step is reached only after a real import, never by skipping.
    await expect(page.getByRole('button', { name: /next: turn on alerts/i })).toHaveCount(0);
    await page.getByLabel(/domains \(one per line\)/i).fill('vintagecoffee.com');
    await page.getByRole('button', { name: /analyze portfolio/i }).click();
    await expect(page.getByRole('button', { name: /next: turn on alerts/i })).toBeVisible();
    await page.getByRole('button', { name: /next: turn on alerts/i }).click();
    await expect(page.getByRole('heading', { name: 'Turn on alerts' })).toBeVisible();
  });
});