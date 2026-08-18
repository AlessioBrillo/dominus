// SPDX-License-Identifier: AGPL-3.0-only
// The billing surface on the community edition: no Stripe keys are ever
// configured, so the page must render the free Community plan, refuse to
// offer paid plans, and the API must fail closed on checkout/portal with
// explicit error codes — paid entry points can never silently half-work.
import { test, expect } from '@playwright/test';
import { E2E_API_KEY, login } from './utils';

test.describe('billing surface (community edition, no Stripe)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('billing page shows the Community plan and the unconfigured note', async ({ page }) => {
    await page.goto('/billing');

    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.getByText('Current Plan', { exact: true })).toBeVisible();
    await expect(page.getByText('Community', { exact: true })).toBeVisible();
    await expect(page.getByText('active', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Billing is not configured on this instance/),
    ).toBeVisible();
  });

  test('paid plans are not offered when Stripe is not configured', async ({ page }) => {
    await page.goto('/billing');

    await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(0);
    await expect(page.getByText('Plans', { exact: true })).toHaveCount(0);
  });

  test('billing API reports the free subscription and unconfigured Stripe', async ({
    request,
  }) => {
    const res = await request.get('/api/v1/billing', {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.subscription.plan).toBe('free');
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.stripeCustomerId).toBeNull();
    expect(body.subscription.stripeSubscriptionId).toBeNull();
    expect(body.isStripeConfigured).toBe(false);
    expect(body.publishableKey).toBeNull();
    for (const plan of body.plans) {
      expect(plan.available).toBe(false);
    }
  });

  test('checkout is refused with BILLING_NOT_CONFIGURED', async ({ request }) => {
    const res = await request.post('/api/v1/billing/checkout', {
      headers: {
        Authorization: `Bearer ${E2E_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        plan: 'pro',
        interval: 'month',
        successUrl: 'http://localhost:3000/billing',
        cancelUrl: 'http://localhost:3000/billing',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  test('portal session is refused with NO_STRIPE_CUSTOMER', async ({ request }) => {
    const res = await request.post('/api/v1/billing/portal', {
      headers: {
        Authorization: `Bearer ${E2E_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { returnUrl: 'http://localhost:3000/billing' },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('NO_STRIPE_CUSTOMER');
  });

  test('checkout rejects invalid payloads with VALIDATION_ERROR', async ({ request }) => {
    const res = await request.post('/api/v1/billing/checkout', {
      headers: {
        Authorization: `Bearer ${E2E_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        plan: 'mega',
        interval: 'month',
        successUrl: 'not-a-url',
        cancelUrl: 'not-a-url',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
