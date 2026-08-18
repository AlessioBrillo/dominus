// SPDX-License-Identifier: AGPL-3.0-only
// Public entry points: the auth gate must protect every private route, the
// SPA must render its 404 page for unknown routes, workspace signup is a
// Cloud-only flow (graceful 404 in the community edition), and the health
// endpoint stays public.
import { test, expect } from '@playwright/test';
import { login } from './utils';

test.describe('public entry points', () => {
  test('deep links require authentication', async ({ page }) => {
    await page.goto('/portfolio');

    await expect(page.getByText('Sign In', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('API Key')).toBeVisible();
  });

  test('unknown routes render the 404 page once signed in', async ({ page }) => {
    await login(page);
    await page.goto('/no-such-route');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByText('404', { exact: true })).toBeVisible();
  });

  test('workspace signup degrades gracefully in the community edition', async ({ page }) => {
    await page.goto('/signup');

    await expect(page.getByText('Create your workspace', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Name').fill('E2E Workspace');
    await page.getByPlaceholder('Email (optional)').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Create workspace' }).click();

    // POST /api/v1/auth/register is only mounted with the Cloud
    // provisioning service; in the community edition the request is
    // rejected by the global auth middleware and the form surfaces the
    // structured error without crashing.
    await expect(page.getByText('Authentication required', { exact: true })).toBeVisible();
  });

  test('health endpoint answers without authentication', async ({ request }) => {
    const res = await request.get('/api/health');

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
