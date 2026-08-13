// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { WebhookEventsRepository } from '../db/repositories/webhook-events-repository.js';
import type {
  Subscription,
  BillingPortalResponse,
  SubscriptionPlan,
} from '../types/subscription.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/**
 * Billing interval for recurring subscriptions.
 * 'month' and 'year' map to the configured monthly/yearly Stripe price IDs.
 */
export type BillingInterval = 'month' | 'year';

/** Plans that can be purchased via Stripe Checkout. */
export const PAID_PLANS: SubscriptionPlan[] = ['pro', 'team', 'enterprise'];

/** Maximum event ids kept in the in-memory dedup fast path. */
const EVENT_ID_CACHE_MAX = 10_000;

/** How long a Stripe idempotency key stays valid on the API side (24h). */
const STRIPE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

type StripeSdk = {
  Stripe: new (
    secretKey: string,
    options?: { apiVersion?: string },
  ) => {
    customers: {
      create: (params: {
        email?: string;
        metadata?: Record<string, string>;
      }) => Promise<{ id: string }>;
      createPortalSession: (params: {
        customer: string;
        return_url: string;
      }) => Promise<{ url: string }>;
    };
    checkout: {
      sessions: {
        create: (params: {
          mode: string;
          customer?: string;
          customer_email?: string;
          line_items: { price: string; quantity: number }[];
          success_url: string;
          cancel_url: string;
          metadata?: Record<string, string>;
          subscription_data?: { trial_period_days?: number };
          idempotency_key?: string;
        }) => Promise<{ id: string; url: string | null }>;
      };
    };
    webhooks: {
      constructEvent: (
        payload: Buffer | string,
        sig: string,
        secret: string,
      ) => { id: string; type: string; data: { object: Record<string, unknown> } };
    };
  };
};

export class BillingService {
  readonly #config: Config;
  readonly #subRepo: SubscriptionRepository;
  readonly #webhookRepo: WebhookEventsRepository | null;
  #stripe: StripeSdk['Stripe']['prototype'] | null = null;
  /** In-memory fast path for webhook dedup (bounded LRU-style set). */
  readonly #processedEventIds = new Map<string, number>();

  constructor(
    config: Config,
    subRepo: SubscriptionRepository,
    webhookRepo?: WebhookEventsRepository,
  ) {
    this.#config = config;
    this.#subRepo = subRepo;
    this.#webhookRepo = webhookRepo ?? null;
  }

  get isConfigured(): boolean {
    return !!this.#config.STRIPE_SECRET_KEY;
  }

  async #getStripe(): Promise<StripeSdk['Stripe']['prototype'] | null> {
    if (this.#stripe) return this.#stripe;
    if (!this.#config.STRIPE_SECRET_KEY) return null;

    try {
      const { Stripe } = await import('stripe');
      this.#stripe = new Stripe(
        this.#config.STRIPE_SECRET_KEY,
      ) as unknown as StripeSdk['Stripe']['prototype'];
      return this.#stripe;
    } catch {
      logger.warn('Stripe SDK not available — billing features disabled');
      return null;
    }
  }

  /**
   * Resolve the configured Stripe Price ID for a plan + interval.
   * Legacy STRIPE_PRICE_ID_MONTHLY / STRIPE_PRICE_ID_YEARLY remain valid
   * aliases for the pro plan (backward compatibility).
   */
  resolvePriceId(plan: SubscriptionPlan, interval: BillingInterval): string | undefined {
    if (plan === 'free') return undefined;
    if (plan === 'pro') {
      return interval === 'month'
        ? (this.#config.STRIPE_PRICE_ID_PRO_MONTHLY ?? this.#config.STRIPE_PRICE_ID_MONTHLY)
        : (this.#config.STRIPE_PRICE_ID_PRO_YEARLY ?? this.#config.STRIPE_PRICE_ID_YEARLY);
    }
    if (plan === 'team') {
      return interval === 'month'
        ? this.#config.STRIPE_PRICE_ID_TEAM_MONTHLY
        : this.#config.STRIPE_PRICE_ID_TEAM_YEARLY;
    }
    return interval === 'month'
      ? this.#config.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY
      : this.#config.STRIPE_PRICE_ID_ENTERPRISE_YEARLY;
  }

  /**
   * Reverse lookup: map a Stripe Price ID back to the plan it belongs to.
   * Used by webhook handlers to derive the subscription plan from the
   * price attached to the subscription line item.
   */
  resolvePlanForPriceId(priceId: string | null | undefined): SubscriptionPlan | undefined {
    if (!priceId) return undefined;
    const configured: Array<[string | undefined, SubscriptionPlan]> = [
      [this.#config.STRIPE_PRICE_ID_MONTHLY, 'pro'],
      [this.#config.STRIPE_PRICE_ID_YEARLY, 'pro'],
      [this.#config.STRIPE_PRICE_ID_PRO_MONTHLY, 'pro'],
      [this.#config.STRIPE_PRICE_ID_PRO_YEARLY, 'pro'],
      [this.#config.STRIPE_PRICE_ID_TEAM_MONTHLY, 'team'],
      [this.#config.STRIPE_PRICE_ID_TEAM_YEARLY, 'team'],
      [this.#config.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY, 'enterprise'],
      [this.#config.STRIPE_PRICE_ID_ENTERPRISE_YEARLY, 'enterprise'],
    ];
    for (const [configuredId, plan] of configured) {
      if (configuredId && configuredId === priceId) return plan;
    }
    return undefined;
  }

  async getSubscription(tenantId: string): Promise<Subscription> {
    return this.#subRepo.ensureDefault(tenantId);
  }

  /**
   * Create a Stripe Checkout session for the given plan and interval.
   * The idempotency key is derived from (tenantId, plan, interval, day) so
   * retries of the same upgrade request reuse the same session instead of
   * creating duplicates; a new day (or a different plan) starts a new key.
   */
  async createCheckoutSession(
    tenantId: string,
    plan: SubscriptionPlan,
    interval: BillingInterval,
    successUrl: string,
    cancelUrl: string,
    customerEmail?: string,
  ): Promise<{ url: string; plan: SubscriptionPlan } | null> {
    const stripe = await this.#getStripe();
    if (!stripe) return null;

    const priceId = this.resolvePriceId(plan, interval);
    if (!priceId) {
      logger.warn(
        { plan, interval },
        'Attempted checkout with no configured priceId for plan/interval',
      );
      return null;
    }

    const sub = await this.#subRepo.findByTenantId(tenantId);

    // Trial only for first-ever checkout: once a tenant has a Stripe
    // customer, new subscriptions (upgrades, re-subscribes) start on a
    // paid cycle — Stripe's trial_period_days would otherwise re-grant 14
    // days on every plan change.
    const firstCheckout = sub?.stripeCustomerId == null;

    // Idempotency window bucket: same tenant+plan+interval within 24h reuses
    // the same key, so Stripe returns the original session on retry instead
    // of creating a second one. See:
    // https://docs.stripe.com/api/idempotent_requests
    const bucket = Math.floor(Date.now() / STRIPE_IDEMPOTENCY_WINDOW_MS);
    const idempotencyKey = `checkout:${tenantId}:${plan}:${interval}:${bucket}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: sub?.stripeCustomerId ?? undefined,
      customer_email: sub?.stripeCustomerId ? undefined : customerEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { tenantId, plan },
      ...(firstCheckout ? { subscription_data: { trial_period_days: 14 } } : {}),
      idempotency_key: idempotencyKey,
    });

    return session.url ? { url: session.url, plan } : null;
  }

  async createPortalSession(
    tenantId: string,
    returnUrl: string,
  ): Promise<BillingPortalResponse | null> {
    const stripe = await this.#getStripe();
    if (!stripe) return null;

    const sub = await this.#subRepo.findByTenantId(tenantId);
    if (!sub?.stripeCustomerId) return null;

    const session = await stripe.customers.createPortalSession({
      customer: sub.stripeCustomerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  }

  /**
   * Dedup gate for webhook events. Stripe delivers at-least-once and may
   * re-deliver across replicas and restarts. The database record is the
   * authoritative source; the in-memory set is a bounded fast path.
   *
   * Fail-closed: when the dedup store is unavailable the claim THROWS, the
   * route answers 4xx, and Stripe re-delivers. Processing a duplicate
   * subscription transition (double upgrade/downgrade, double trial grant)
   * is a worse failure than a webhook that retries.
   */
  async #claimEvent(eventId: string, eventType: string): Promise<boolean> {
    const inMemory = this.#processedEventIds.get(eventId);
    if (inMemory !== undefined) {
      if (Date.now() - inMemory > STRIPE_IDEMPOTENCY_WINDOW_MS) {
        this.#processedEventIds.delete(eventId);
      } else {
        logger.debug({ eventId, eventType }, 'Duplicate webhook event (in-memory) — skipping');
        return false;
      }
    }

    if (this.#webhookRepo) {
      const newlyRecorded = await this.#webhookRepo.markProcessed('stripe', eventId, eventType);
      if (!newlyRecorded) {
        logger.debug({ eventId, eventType }, 'Duplicate webhook event (store) — skipping');
        return false;
      }
    }

    this.#processedEventIds.set(eventId, Date.now());
    if (this.#processedEventIds.size > EVENT_ID_CACHE_MAX) {
      const oldest = this.#processedEventIds.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this.#processedEventIds.delete(oldest.value);
      }
    }
    return true;
  }

  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<void> {
    const stripe = await this.#getStripe();
    if (!stripe || !this.#config.STRIPE_WEBHOOK_SECRET) {
      logger.warn('Stripe webhook received but billing is not configured');
      return;
    }

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.#config.STRIPE_WEBHOOK_SECRET,
    );

    const claimed = await this.#claimEvent(event.id, event.type);
    if (!claimed) return;

    logger.info({ type: event.type, eventId: event.id }, 'Stripe webhook event');

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          metadata?: Record<string, string>;
          customer?: string;
          subscription?: string;
          mode?: string;
        };
        if (session.mode !== 'subscription') return;

        const tenantId = session.metadata?.tenantId;
        if (!tenantId) {
          logger.warn({ eventId: event.id }, 'Checkout session missing tenantId metadata');
          return;
        }

        const plan = (session.metadata?.plan as SubscriptionPlan | undefined) ?? 'pro';
        await this.#subRepo.upsert({
          tenantId,
          plan,
          status: 'active',
          stripeCustomerId: session.customer ?? null,
          stripeSubscriptionId: session.subscription ?? null,
          currentPeriodStart: new Date().toISOString(),
        });
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object as {
          id?: string;
          customer?: string;
          status?: string;
          current_period_start?: number;
          current_period_end?: number;
          metadata?: Record<string, string>;
          items?: { data?: { price?: { id?: string } }[] };
        };

        const planFromPrice = this.resolvePlanForPriceId(sub.items?.data?.[0]?.price?.id ?? null);
        const plan = planFromPrice ?? (sub.metadata?.plan as SubscriptionPlan | undefined);

        const tenantId = sub.metadata?.tenantId;
        if (tenantId) {
          await this.#subRepo.updateStripeSubscription(
            tenantId,
            sub.id ?? '',
            (sub.status as 'active' | 'past_due' | 'canceled' | 'incomplete') ?? 'active',
            sub.current_period_start
              ? new Date(sub.current_period_start * 1000).toISOString()
              : new Date().toISOString(),
            sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : new Date().toISOString(),
            plan,
          );
          return;
        }

        const custSub = await this.#subRepo.findByStripeCustomerId(sub.customer ?? '');
        if (!custSub) {
          logger.warn(
            { eventId: event.id, customerId: sub.customer },
            'Subscription event for unknown customer',
          );
          return;
        }
        await this.#subRepo.updateStripeSubscription(
          custSub.tenantId,
          sub.id ?? '',
          (sub.status as 'active' | 'past_due' | 'canceled' | 'incomplete') ?? 'active',
          sub.current_period_start
            ? new Date(sub.current_period_start * 1000).toISOString()
            : new Date().toISOString(),
          sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : new Date().toISOString(),
          plan,
        );
        break;
      }

      case 'invoice.payment_failed': {
        // Dunning signal: mark the subscription past_due immediately so
        // usage enforcement fails closed to free-plan limits (ADR-0053).
        // The later customer.subscription.updated carries the same status;
        // handling the invoice event first just shortens the exposure.
        const invoice = event.data.object as { customer?: string };
        const failTenant = (await this.#subRepo.findByStripeCustomerId(invoice.customer ?? ''))
          ?.tenantId;
        if (failTenant) {
          await this.#subRepo.updateStatus(failTenant, 'past_due');
          logger.warn({ tenantId: failTenant, eventId: event.id }, 'Invoice payment failed');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const deletedSub = event.data.object as { customer?: string };
        const delTenantId = (await this.#subRepo.findByStripeCustomerId(deletedSub.customer ?? ''))
          ?.tenantId;
        if (delTenantId) {
          await this.#subRepo.cancel(delTenantId, new Date().toISOString());
        }
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe webhook event');
    }
  }
}
