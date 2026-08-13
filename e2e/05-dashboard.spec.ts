// SPDX-License-Identifier: AGPL-3.0-only
// Depends on the seeded portfolio (2 entries) and on onboarding being
// completed. The beforeEach marks onboarding complete via the API — an
// idempotent upsert — so this spec is order-independent. The onboarding spec
// (03) only ever moves the wizard to intermediate steps, never to 'complete'.
import { test, expect } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

test.describe('dashboard', () => {
  test.beforeEach(async ({ page, request }) => {
    await login(page);
    const res = await request.patch('/api/v1/onboarding/state', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
      data: { currentStep: 'complete' },
    });
    if (!res.ok()) {
      throw new Error(`failed to complete onboarding: ${res.status()} ${await res.text()}`);
    }
  });

  test('renders portfolio stats once onboarding is complete', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Portfolio Domains')).toBeVisible();
    await expect(page.getByText('Keep / Drop')).toBeVisible();
    await expect(page.getByText('Portfolio Value')).toBeVisible();
    await expect(page.getByText('Active Alerts')).toBeVisible();
    await expect(page.getByText('€1290')).toBeVisible();
  });

  test('does not redirect back to onboarding once completed', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/onboarding/);
  });
});