// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { login } from './utils';

test.describe('candidates', () => {
  test('lists candidates from the most recent run', async ({ page }) => {
    await login(page);
    await page.goto('/candidates');

    await expect(page.getByRole('heading', { name: 'Candidates' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'candidate-one.com' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'candidate-two.io' })).toBeVisible();
    await expect(page.getByText(/Recommended/)).toBeVisible();
    await expect(page.getByText(/Scored/)).toBeVisible();
  });

  test('buying a recommended candidate opens the purchase page', async ({ page }) => {
    await login(page);
    await page.goto('/candidates');

    await page.getByRole('button', { name: /Buy/ }).click();
    await expect(page.getByRole('heading', { name: 'Purchase' })).toBeVisible();

    await page.getByRole('button', { name: 'Proceed' }).click();
    await expect(page).toHaveURL(/\/buy\?domain=candidate-one\.com/);
    await expect(page.getByRole('heading', { name: 'Purchase' })).toBeVisible();
  });
});