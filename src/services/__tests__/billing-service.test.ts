// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Config } from '../../config.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import { WebhookEventsRepository } from '../../db/repositories/webhook-events-repository.js';
import { BillingService } from '../billing-service.js';

const mockStripeApi = {
  constructEvent: vi.fn(),
  createSession: vi.fn(),
  createPortal: vi.fn(),
};

vi.mock('stripe', () => ({
  Stripe: class {
    webhooks = { constructEvent: mockStripeApi.constructEvent };
    customers = { createPortalSession: mockStripeApi.createPortal };
    checkout = { sessions: { create: mockStripeApi.createSession } };
  },
}));

const baseConfig = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
  STRIPE_PRICE_ID_MONTHLY: 'price_legacy_monthly',
  STRIPE_PRICE_ID_YEARLY: 'price_legacy_yearly',
  STRIPE_PRICE_ID_PRO_MONTHLY: 'price_pro_monthly',
  STRIPE_PRICE_ID_PRO_YEARLY: 'price_pro_yearly',
  STRIPE_PRICE_ID_ENTERPRISE_MONTHLY: 'price_ent_monthly',
  STRIPE_PRICE_ID_ENTERPRISE_YEARLY: 'price_ent_yearly',
} as Config;

function stubWebhookEvent(event: {
  id: string;
  type: string;
  object: Record<string, unknown>;
}): void {
  mockStripeApi.constructEvent.mockReturnValue({
    id: event.id,
    type: event.type,
    data: { object: event.object },
  });
}

describe('BillingService price resolution', () => {
  it('prefers explicit pro price IDs over legacy aliases', () => {
    const service = new BillingService(baseConfig, {} as SubscriptionRepository);
    expect(service.resolvePriceId('pro', 'month')).toBe('price_pro_monthly');
    expect(service.resolvePriceId('pro', 'year')).toBe('price_pro_yearly');
  });

  it('falls back to legacy aliases for pro when explicit IDs are unset', () => {
    const cfg = {
      ...baseConfig,
      STRIPE_PRICE_ID_PRO_MONTHLY: undefined,
      STRIPE_PRICE_ID_PRO_YEARLY: undefined,
    } as Config;
    const service = new BillingService(cfg, {} as SubscriptionRepository);
    expect(service.resolvePriceId('pro', 'month')).toBe('price_legacy_monthly');
    expect(service.resolvePriceId('pro', 'year')).toBe('price_legacy_yearly');
  });

  it('resolves enterprise price IDs', () => {
    const service = new BillingService(baseConfig, {} as SubscriptionRepository);
    expect(service.resolvePriceId('enterprise', 'month')).toBe('price_ent_monthly');
    expect(service.resolvePriceId('enterprise', 'year')).toBe('price_ent_yearly');
  });

  it('returns undefined for the free plan', () => {
    const service = new BillingService(baseConfig, {} as SubscriptionRepository);
    expect(service.resolvePriceId('free', 'month')).toBeUndefined();
    expect(service.resolvePriceId('free', 'year')).toBeUndefined();
  });

  it('maps price IDs back to plans', () => {
    const service = new BillingService(baseConfig, {} as SubscriptionRepository);
    expect(service.resolvePlanForPriceId('price_pro_monthly')).toBe('pro');
    expect(service.resolvePlanForPriceId('price_legacy_yearly')).toBe('pro');
    expect(service.resolvePlanForPriceId('price_ent_monthly')).toBe('enterprise');
    expect(service.resolvePlanForPriceId('price_unknown')).toBeUndefined();
    expect(service.resolvePlanForPriceId(null)).toBeUndefined();
  });
});

describe('BillingService.checkout', () => {
  let db: SqliteProvider;
  let subRepo: SubscriptionRepository;
  let webhookRepo: WebhookEventsRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    subRepo = new SubscriptionRepository(db);
    webhookRepo = new WebhookEventsRepository(db);
    vi.clearAllMocks();
    mockStripeApi.createSession.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay_1',
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates a checkout session with plan price, metadata, and idempotency key', async () => {
    const service = new BillingService(baseConfig, subRepo, webhookRepo);

    const result = await service.createCheckoutSession(
      'tenant-1',
      'pro',
      'month',
      'https://dominus.app/billing?ok=1',
      'https://dominus.app/billing?cancel=1',
      'user@example.com',
    );

    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/pay_1', plan: 'pro' });
    expect(mockStripeApi.createSession).toHaveBeenCalledTimes(1);
    const call = mockStripeApi.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.line_items).toEqual([{ price: 'price_pro_monthly', quantity: 1 }]);
    expect(call.mode).toBe('subscription');
    expect(call.metadata).toMatchObject({ tenantId: 'tenant-1', plan: 'pro' });
    expect(typeof call.idempotency_key).toBe('string');
    expect((call.idempotency_key as string).startsWith('checkout:tenant-1:pro:month:')).toBe(true);
  });

  it('returns null when no price is configured for the plan', async () => {
    const cfg = {
      ...baseConfig,
      STRIPE_PRICE_ID_ENTERPRISE_MONTHLY: undefined,
      STRIPE_PRICE_ID_ENTERPRISE_YEARLY: undefined,
    } as Config;
    const service = new BillingService(cfg, subRepo, webhookRepo);

    const result = await service.createCheckoutSession(
      'tenant-1',
      'enterprise',
      'month',
      'https://dominus.app/billing?ok=1',
      'https://dominus.app/billing?cancel=1',
    );

    expect(result).toBeNull();
    expect(mockStripeApi.createSession).not.toHaveBeenCalled();
  });

  it('returns null when billing is not configured', async () => {
    const cfg = { ...baseConfig, STRIPE_SECRET_KEY: undefined } as Config;
    const service = new BillingService(cfg, subRepo, webhookRepo);

    const result = await service.createCheckoutSession(
      'tenant-1',
      'pro',
      'month',
      'https://dominus.app/billing?ok=1',
      'https://dominus.app/billing?cancel=1',
    );

    expect(result).toBeNull();
  });
});

describe('BillingService webhook handling', () => {
  let db: SqliteProvider;
  let subRepo: SubscriptionRepository;
  let webhookRepo: WebhookEventsRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    subRepo = new SubscriptionRepository(db);
    webhookRepo = new WebhookEventsRepository(db);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.close();
  });

  const RAW = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}', 'utf8');

  it('upserts a subscription on checkout.session.completed', async () => {
    stubWebhookEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      object: {
        mode: 'subscription',
        metadata: { tenantId: 'tenant-1', plan: 'pro' },
        customer: 'cus_1',
        subscription: 'sub_1',
      },
    });
    const service = new BillingService(baseConfig, subRepo, webhookRepo);

    await service.handleWebhookEvent(RAW, 'sig');

    const sub = await subRepo.findByTenantId('tenant-1');
    expect(sub).toMatchObject({
      tenantId: 'tenant-1',
      plan: 'pro',
      status: 'active',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
  });

  it('skips a duplicate event delivery', async () => {
    stubWebhookEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      object: {
        mode: 'subscription',
        metadata: { tenantId: 'tenant-1', plan: 'pro' },
        customer: 'cus_1',
        subscription: 'sub_1',
      },
    });
    const service = new BillingService(baseConfig, subRepo, webhookRepo);

    await service.handleWebhookEvent(RAW, 'sig');
    await service.handleWebhookEvent(RAW, 'sig');

    const sub = await subRepo.findByTenantId('tenant-1');
    expect(sub?.stripeSubscriptionId).toBe('sub_1');
  });

  it('derives the plan from the price on customer.subscription.updated', async () => {
    await subRepo.upsert({
      tenantId: 'tenant-1',
      plan: 'free',
      status: 'active',
      stripeCustomerId: 'cus_2',
    });
    stubWebhookEvent({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      object: {
        id: 'sub_2',
        customer: 'cus_2',
        status: 'active',
        current_period_start: 1_752_537_600,
        current_period_end: 1_755_417_600,
        items: { data: [{ price: { id: 'price_ent_monthly' } }] },
      },
    });
    const service = new BillingService(baseConfig, subRepo, webhookRepo);

    await service.handleWebhookEvent(RAW, 'sig');

    const sub = await subRepo.findByTenantId('tenant-1');
    expect(sub?.plan).toBe('enterprise');
  });

  it('ignores non-subscription checkout sessions', async () => {
    stubWebhookEvent({
      id: 'evt_3',
      type: 'checkout.session.completed',
      object: { mode: 'payment' },
    });
    const service = new BillingService(baseConfig, subRepo, webhookRepo);

    await service.handleWebhookEvent(RAW, 'sig');

    expect(await subRepo.findByTenantId('tenant-1')).toBeUndefined();
  });
});
