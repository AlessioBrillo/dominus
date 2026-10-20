// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The Cloud UI smoke tests (ADR-0095).
//
// Three smokes, not a second full suite. The SQLite suite (e2e/) already
// covers the pages; what only the Cloud can break is the wiring between
// the SPA and the tenant-scoped data — a login that does not carry the
// tenant, a list that does not filter, a billing page that does not show
// the granted plan. Those are exactly three things, and they are what
// these three tests assert.
import { test, expect, type Page } from '@playwright/test';
import { loadCloudFixtures } from './fixtures';

const fixtures = loadCloudFixtures();

/** Authenticates through the real login form, as a user would. */
async function login(page: Page, apiKey: string): Promise<void> {
  await page.goto('/');
  const input = page.getByPlaceholder('API Key');
  await input.waitFor({ state: 'visible' });
  await input.fill(apiKey);
  await page.getByRole('button', { name: 'Authenticate' }).click();
  await page.getByPlaceholder('API Key').waitFor({ state: 'detached' });
}

test.describe('cloud acceptance — the SPA against the tenant-scoped data', () => {
  test('a tenant signs in and sees its own portfolio only', async ({ page }) => {
    await login(page, fixtures.tenantA.key);
    await page.goto('/portfolio');

    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    const table = page.getByTestId('portfolio-table');
    await expect(table.locator('tr').filter({ hasText: fixtures.tenantA.domain })).toBeVisible();
    // The other tenant's row must not be in this tenant's table: the API
    // filters it, and this is the browser-side proof that it really does.
    await expect(table.locator('tr').filter({ hasText: fixtures.tenantB.domain })).toHaveCount(0);
  });

  test('the second tenant sees the other side of the isolation', async ({ page }) => {
    await login(page, fixtures.tenantB.key);
    await page.goto('/portfolio');

    const table = page.getByTestId('portfolio-table');
    await expect(table.locator('tr').filter({ hasText: fixtures.tenantB.domain })).toBeVisible();
    await expect(table.locator('tr').filter({ hasText: fixtures.tenantA.domain })).toHaveCount(0);
  });

  test('the billing page shows the plan the webhook granted', async ({ page }) => {
    await login(page, fixtures.tenantA.key);
    await page.goto('/billing');

    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.getByText('Current Plan', { exact: true })).toBeVisible();
    // The acceptance runner delivered a signed checkout.session.completed
    // for the pro price: the SPA must show the granted plan, not the
    // default one.
    await expect(page.getByText('Pro', { exact: true }).first()).toBeVisible();
  });
});
