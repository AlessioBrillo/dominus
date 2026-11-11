// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createBillingRouter } from '../billing.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { Config } from '../../../config.js';
import type { BillingService } from '../../../services/billing-service.js';

const config = {
  PUBLIC_APP_URL: 'https://dominus.app',
  STRIPE_SECRET_KEY: 'sk_test_123',
} as Config;

function buildApp(service: Partial<BillingService>): Application {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'tenant-1';
    req.auth = { role: 'admin', tenantId: 'tenant-1', userId: 'user-1' };
    next();
  });

  app.use('/api/v1/billing', createBillingRouter(config, service as BillingService));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/billing/subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('changes the plan on the existing subscription', async () => {
    const changeSubscription = vi.fn(async () => ({
      subscriptionId: 'sub_1',
      priceId: 'price_team_monthly',
      plan: 'team' as const,
    }));
    const app = buildApp({ isConfigured: true, changeSubscription } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/subscription')
      .send({ action: 'change', plan: 'team', interval: 'month' });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('team');
    expect(changeSubscription).toHaveBeenCalledWith('tenant-1', 'team', 'month');
  });

  it('answers NO_SUBSCRIPTION when the tenant has none', async () => {
    const changeSubscription = vi.fn(async () => null);
    const getSubscription = vi.fn(async () => ({
      id: 1,
      tenantId: 'tenant-1',
      plan: 'free' as const,
      status: 'active' as const,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEnd: null,
      canceledAt: null,
      createdAt: '',
      updatedAt: '',
    }));
    const app = buildApp({
      isConfigured: true,
      changeSubscription,
      getSubscription,
    } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/subscription')
      .send({ action: 'change', plan: 'team', interval: 'month' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_SUBSCRIPTION');
  });

  it('answers PRICE_NOT_CONFIGURED when the price of the plan is unknown', async () => {
    const changeSubscription = vi.fn(async () => null);
    const getSubscription = vi.fn(async () => ({
      id: 1,
      tenantId: 'tenant-1',
      plan: 'pro' as const,
      status: 'active' as const,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEnd: null,
      canceledAt: null,
      createdAt: '',
      updatedAt: '',
    }));
    const app = buildApp({
      isConfigured: true,
      changeSubscription,
      getSubscription,
    } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/subscription')
      .send({ action: 'change', plan: 'team', interval: 'month' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRICE_NOT_CONFIGURED');
  });

  it('cancels the subscription', async () => {
    const cancelSubscription = vi.fn(async () => ({
      subscriptionId: 'sub_1',
      cancelAtPeriodEnd: false,
    }));
    const app = buildApp({
      isConfigured: true,
      cancelSubscription,
    } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/subscription')
      .send({ action: 'cancel', mode: 'immediate' });

    expect(res.status).toBe(200);
    expect(res.body.cancelAtPeriodEnd).toBe(false);
    expect(cancelSubscription).toHaveBeenCalledWith('tenant-1', 'immediate');
  });

  it('defaults the cancellation to the end of the period', async () => {
    const cancelSubscription = vi.fn(async () => ({
      subscriptionId: 'sub_1',
      cancelAtPeriodEnd: true,
    }));
    const app = buildApp({
      isConfigured: true,
      cancelSubscription,
    } as unknown as BillingService);

    const res = await request(app).post('/api/v1/billing/subscription').send({ action: 'cancel' });

    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalledWith('tenant-1', 'period_end');
  });

  it('refuses an unknown action', async () => {
    const app = buildApp({ isConfigured: true } as unknown as BillingService);

    const res = await request(app).post('/api/v1/billing/subscription').send({ action: 'destroy' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers BILLING_NOT_CONFIGURED when Stripe is not configured', async () => {
    const app = buildApp({ isConfigured: false } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/subscription')
      .send({ action: 'change', plan: 'team', interval: 'month' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });
});

describe('API: /api/v1/billing checkout redirects', () => {
  it('refuses a success URL on a lookalike host', async () => {
    const createCheckoutSession = vi.fn(async () => ({
      url: 'https://checkout.stripe.com/c/pay_1',
      plan: 'pro' as const,
    }));
    const app = buildApp({
      isConfigured: true,
      createCheckoutSession,
    } as unknown as BillingService);

    const res = await request(app).post('/api/v1/billing/checkout').send({
      plan: 'pro',
      interval: 'month',
      successUrl: 'https://dominus.app.attacker.tld/steal',
      cancelUrl: 'https://dominus.app/billing',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses a portal return URL on a lookalike host', async () => {
    const createPortalSession = vi.fn(async () => ({ url: 'https://stripe.test/portal' }));
    const app = buildApp({
      isConfigured: true,
      createPortalSession,
    } as unknown as BillingService);

    const res = await request(app)
      .post('/api/v1/billing/portal')
      .send({ returnUrl: 'https://dominus.app.attacker.tld/steal' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(createPortalSession).not.toHaveBeenCalled();
  });
});
