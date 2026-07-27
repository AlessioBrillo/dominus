import type { Config } from '../config.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { Subscription, BillingPortalResponse } from '../types/subscription.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

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
        }) => Promise<{ id: string; url: string | null }>;
      };
    };
    webhooks: {
      constructEvent: (
        payload: Buffer | string,
        sig: string,
        secret: string,
      ) => { type: string; data: { object: Record<string, unknown> } };
    };
  };
};

export class BillingService {
  readonly #config: Config;
  readonly #subRepo: SubscriptionRepository;
  #stripe: StripeSdk['Stripe']['prototype'] | null = null;

  constructor(config: Config, subRepo: SubscriptionRepository) {
    this.#config = config;
    this.#subRepo = subRepo;
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

  async getSubscription(tenantId: string): Promise<Subscription> {
    return this.#subRepo.ensureDefault(tenantId);
  }

  async createCheckoutSession(
    tenantId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
    customerEmail?: string,
  ): Promise<{ url: string } | null> {
    const stripe = await this.#getStripe();
    if (!stripe) return null;

    const sub = await this.#subRepo.findByTenantId(tenantId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: sub?.stripeCustomerId ?? undefined,
      customer_email: sub?.stripeCustomerId ? undefined : customerEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { tenantId },
      subscription_data: { trial_period_days: 14 },
    });

    return session.url ? { url: session.url } : null;
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

    logger.info({ type: event.type }, 'Stripe webhook event');

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
          logger.warn('Checkout session missing tenantId metadata');
          return;
        }

        await this.#subRepo.upsert({
          tenantId,
          plan: 'pro',
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
          items?: { data?: { price?: { product?: string } }[] };
        };

        const tenantId = sub.metadata?.tenantId;
        if (!tenantId) {
          const custSub = await this.#subRepo.findByStripeCustomerId(sub.customer ?? '');
          if (!custSub) {
            logger.warn({ customerId: sub.customer }, 'Subscription event for unknown customer');
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
          );
        } else {
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
          );
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
