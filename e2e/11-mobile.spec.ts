// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { login } from './utils';

/**
 * Mobile shell guardrail (ADR-0114). Runs in the desktop Chromium project but
 * with a phone viewport, so the five-decision shell and the PWA assets cannot
 * regress silently while every other spec keeps its desktop contract.
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.describe('mobile shell', () => {
  test('shows the five decision destinations after sign-in', async ({ page }) => {
    await login(page);
    const nav = page.getByRole('navigation', { name: 'Mobile' });
    await expect(nav).toBeVisible();
    for (const name of ['Today', 'Appraise', 'Holdings', 'Alerts', 'More']) {
      await expect(nav.getByRole('button', { name })).toBeVisible();
    }
  });

  test('opens the secondary menu and reaches an advanced page', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Open all sections' }).click();
    const dialog = page.getByRole('dialog', { name: 'All sections' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('the portfolio uses cards instead of the wide table', async ({ page }) => {
    await login(page);
    await page
      .getByRole('navigation', { name: 'Mobile' })
      .getByRole('button', { name: 'Holdings' })
      .click();
    await expect(page.getByTestId('portfolio-cards')).toBeVisible();
    await expect(page.getByTestId('portfolio-table')).toBeHidden();
  });

  test('the alerts screen is reachable from the bottom bar', async ({ page }) => {
    await login(page);
    await page
      .getByRole('navigation', { name: 'Mobile' })
      .getByRole('button', { name: 'Alerts' })
      .click();
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  });

  test('serves an installable manifest and an app-shell worker', async ({ request }) => {
    const manifestResponse = await request.get('/manifest.webmanifest');
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    const workerResponse = await request.get('/sw.js');
    expect(workerResponse.ok()).toBeTruthy();
    expect(await workerResponse.text()).toContain('dominus-shell');
  });
});
