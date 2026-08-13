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

  test('a fresh install redirects to the onboarding wizard', async ({ page }) => {
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();
    await expect(
      page.getByText('Set up DOMINUS for your domain portfolio in 3 steps'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome to DOMINUS' })).toBeVisible();
  });

  test('step navigation moves between wizard steps', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Welcome to DOMINUS' })).toBeVisible();

    await page.getByRole('button', { name: 'Get Started' }).click();
    await expect(page.getByRole('heading', { name: 'See it in action' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run Sample' })).toBeVisible();
  });
});