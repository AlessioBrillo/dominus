// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { login } from './utils';

test.describe('portfolio', () => {
  test('shows the seeded portfolio entries', async ({ page }) => {
    await login(page);
    await page.goto('/portfolio');

    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    // Scoped to the portfolio table: the page also renders the carry-cost
    // table (ADR-0083 M5), whose rows carry the same domain names. A
    // page-wide `tr` filter matches both tables and trips Playwright's
    // strict-mode violation — the drift that kept this spec red.
    const portfolio = page.getByTestId('portfolio-table');
    const keepRow = portfolio.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(keepRow).toBeVisible();
    await expect(keepRow.getByText('keep', { exact: true })).toBeVisible();
    await expect(portfolio.locator('tr').filter({ hasText: 'drop-domain.net' })).toBeVisible();
  });

  test('changing a verdict via the row menu persists across reloads', async ({ page }) => {
    await login(page);
    await page.goto('/portfolio');

    const portfolio = page.getByTestId('portfolio-table');
    const row = portfolio.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(row.getByText('keep', { exact: true })).toBeVisible();

    await row.getByRole('button').nth(1).click();
    await page.getByRole('menuitem', { name: 'Drop' }).click();

    await expect(row.getByText('drop', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.reload();
    const rowAfterReload = portfolio.locator('tr').filter({ hasText: 'keep-domain.com' });
    await expect(rowAfterReload.getByText('drop', { exact: true })).toBeVisible();
  });
});
