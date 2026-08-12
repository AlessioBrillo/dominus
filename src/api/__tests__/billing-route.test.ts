// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBillingRouter } from '../routes/billing.js';
import type { BillingService } from '../../services/billing-service.js';

function buildApp(service: BillingService): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/billing', createBillingRouter({} as never, service));
  return app;
}

function fakeBillingService(overrides: Partial<BillingService> = {}): BillingService {
  return {
    getSubscription: vi.fn().mockResolvedValue({ plan: 'free', status: 'active' }),
    resolvePriceId: vi.fn((plan: string, interval: string) =>
      plan === 'free' ? undefined : `price_${plan}_${interval}`,
    ),
    isConfigured: true,
    createCheckoutSession: vi.fn().mockResolvedValue({
      url: 'https://checkout.stripe.com/pay_1',
      plan: 'team',
    }),
    createPortalSession: vi.fn(),
    ...overrides,
  } as unknown as BillingService;
}

describe('billing router', () => {
  it('lists pro, team and enterprise plans', async () => {
    const res = await request(buildApp(fakeBillingService())).get('/billing');
    expect(res.status).toBe(200);
    const ids = res.body.plans.map((p: { id: string }) => p.id);
    expect(ids).toEqual(['pro', 'team', 'enterprise']);
  });

  it('accepts a team checkout and forwards the plan', async () => {
    const service = fakeBillingService();
    const res = await request(buildApp(service)).post('/billing/checkout').send({
      plan: 'team',
      interval: 'year',
      successUrl: 'https://dominus.app/billing?ok=1',
      cancelUrl: 'https://dominus.app/billing?cancel=1',
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/pay_1');
    expect(service.createCheckoutSession).toHaveBeenCalledWith(
      'default',
      'team',
      'year',
      'https://dominus.app/billing?ok=1',
      'https://dominus.app/billing?cancel=1',
      undefined,
    );
  });

  it('rejects plans outside the sellable set', async () => {
    const res = await request(buildApp(fakeBillingService())).post('/billing/checkout').send({
      plan: 'free',
      interval: 'month',
      successUrl: 'https://dominus.app/billing?ok=1',
      cancelUrl: 'https://dominus.app/billing?cancel=1',
    });
    expect(res.status).toBe(400);
  });
});
