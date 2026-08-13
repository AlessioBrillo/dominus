// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { login } from './utils';

test.describe('portfolio', () => {
  test('shows the seeded portfolio entries', async ({ page }) => {
    await login(page);
    await page.goto('/portfolio');

    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    const keepRow = page.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(keepRow).toBeVisible();
    await expect(keepRow.getByText('keep', { exact: true })).toBeVisible();
    await expect(page.locator('tr').filter({ hasText: 'drop-domain.net' })).toBeVisible();
  });

  test('changing a verdict via the row menu persists across reloads', async ({ page }) => {
    await login(page);
    await page.goto('/portfolio');

    const row = page.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(row.getByText('keep', { exact: true })).toBeVisible();

    await row.getByRole('button').nth(1).click();
    await page.getByRole('menuitem', { name: 'Drop' }).click();

    await expect(row.getByText('drop', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.reload();
    const rowAfterReload = page.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(rowAfterReload.getByText('drop', { exact: true })).toBeVisible();
  });
});