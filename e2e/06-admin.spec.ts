// SPDX-License-Identifier: AGPL-3.0-only
// The admin surface (ADR-0032) is role-gated: the default community auth
// (env API keys) has no role, so /admin must render a graceful "requires an
// admin API key" state and the admin API must deny the community key — no
// tenant data may leak to a self-hosted install.
import { test, expect } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

test.describe('admin surface (community edition)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('admin page explains that the admin role is required', async ({ page }) => {
    await page.goto('/admin');

    await expect(
      page.getByText('This view requires an admin API key', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('No tenants', { exact: true })).toHaveCount(0);
  });

  test('admin API denies the community key with 403', async ({ request }) => {
    const res = await request.get('/api/v1/admin/overview', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
