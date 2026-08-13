// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { E2E_API_KEY } from './utils';

test.describe('authentication', () => {
  test('unauthenticated visitors see the sign-in form', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Sign In', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('API Key')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Authenticate' })).toBeVisible();
  });

  test('an invalid API key shows an error and stays signed out', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('API Key').fill('sk-invalid-key');
    await page.getByRole('button', { name: 'Authenticate' }).click();

    await expect(
      page.getByText(/Authentication failed|Authentication required|Invalid API key|Forbidden/i),
    ).toBeVisible();
    await expect(page.getByText('Sign In', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('API Key')).toBeVisible();
  });

  test('a valid API key unlocks the app shell', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('API Key').fill(E2E_API_KEY);
    await page.getByRole('button', { name: 'Authenticate' }).click();

    await expect(page.getByPlaceholder('API Key')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
  });
});