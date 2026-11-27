// SPDX-License-Identifier: AGPL-3.0-only
// Mobile credential and push contract (ADR-0116). The E2E server boots without
// VAPID keys, so the push opt-in must fail closed and say so; native FCM/APNs
// is deliberately not part of this gate.
import { test, expect } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

test.describe('mobile device and push', () => {
  test.beforeEach(async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${E2E_API_KEY}` };
    await request.patch('/api/v1/onboarding/state', {
      headers,
      data: { currentStep: 'complete' },
    });
    // Device rows are tenant state and survive retries. Revoke any left over
    // from a previous attempt so the mint/revoke assertion stays exact.
    const existing = await request.get('/api/v1/mobile/devices', { headers });
    const devices = (await existing.json()) as {
      devices: Array<{ id: number; revokedAt?: string }>;
    };
    for (const device of devices.devices.filter((item) => !item.revokedAt)) {
      await request.delete(`/api/v1/mobile/devices/${device.id}`, { headers });
    }
  });

  test('a device credential can be minted and revoked from Account', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    await page.getByRole('button', { name: /add this device/i }).click();

    const deviceRow = page
      .locator('li:not([data-sonner-toast])')
      .filter({ hasText: 'This device' });
    await expect(deviceRow).toBeVisible();
    await deviceRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(deviceRow.getByText('Revoked')).toBeVisible();
  });

  test('push opt-in fails closed when VAPID is not configured', async ({ page }) => {
    await page.goto('/account');
    await expect(
      page.getByText('Push is not configured on this server. Alerts remain available in the Alerts tab.'),
    ).toBeVisible();
  });

  test('the Today inbox states its evidence and the tab bar keeps working', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('today-evidence')).toBeVisible();
    await expect(page.getByText(/market data:/i)).toBeVisible();
    await page.getByRole('navigation', { name: 'Mobile' }).getByRole('button', { name: 'Alerts' }).click();
    await expect(page).toHaveURL(/\/alerts$/);
  });
});
