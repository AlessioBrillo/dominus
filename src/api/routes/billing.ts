// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { BillingInterval, BillingService } from '../../services/billing-service.js';
import { ContractAcceptanceError, getContractService } from '../../services/contract-service.js';
import type { Config } from '../../config.js';
import type { SubscriptionPlan } from '../../types/subscription.js';
import { isAllowedAppUrl } from '../route-utils.js';

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'team', 'enterprise']),
  interval: z.enum(['month', 'year']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  // Optional: custom price ID for enterprise custom pricing (admin use)
  customPriceId: z.string().optional(),
  // The acceptance of a specific version of the terms, recorded first-party.
  contract: z
    .object({
      documentVersion: z.string().min(1).max(64),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      businessCustomer: z.boolean().default(false),
    })
    .optional(),
});

/**
 * The subscription lifecycle: a plan change and a cancellation.
 *
 * A plan change MUST mutate the existing Stripe subscription. Opening a
 * new Checkout for a customer who already subscribes leaves them with two
 * active subscriptions and two invoices, which is the defect this
 * endpoint exists to remove.
 */
const subscriptionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('change'),
    plan: z.enum(['pro', 'team', 'enterprise']),
    interval: z.enum(['month', 'year']),
    contract: z
      .object({
        documentVersion: z.string().min(1).max(64),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/),
        businessCustomer: z.boolean().default(false),
      })
      .optional(),
  }),
  z.object({
    action: z.literal('cancel'),
    mode: z.enum(['immediate', 'period_end']).default('period_end'),
  }),
]);

export function createBillingRouter(config: Config, billingService: BillingService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscription = await billingService.getSubscription(req.tenantId ?? 'default');
      const sellable = config.CLOUD_PAID_ENABLED && billingService.isConfigured;
      const plans: Array<{
        id: SubscriptionPlan;
        name: string;
        monthlyPriceId: string | null;
        yearlyPriceId: string | null;
        available: boolean;
      }> = [
        {
          id: 'pro',
          name: 'Pro',
          monthlyPriceId: billingService.resolvePriceId('pro', 'month') ?? null,
          yearlyPriceId: billingService.resolvePriceId('pro', 'year') ?? null,
          available: sellable,
        },
        {
          id: 'team',
          name: 'Team',
          monthlyPriceId: billingService.resolvePriceId('team', 'month') ?? null,
          yearlyPriceId: billingService.resolvePriceId('team', 'year') ?? null,
          available: sellable,
        },
        {
          id: 'enterprise',
          name: 'Enterprise',
          monthlyPriceId: billingService.resolvePriceId('enterprise', 'month') ?? null,
          yearlyPriceId: billingService.resolvePriceId('enterprise', 'year') ?? null,
          available: sellable,
        },
      ];
      res.json({
        subscription,
        plans,
        isStripeConfigured: billingService.isConfigured,
        checkoutEnabled: config.CLOUD_PAID_ENABLED,
        publishableKey: config.STRIPE_PUBLISHABLE_KEY ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/checkout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // CLOUD_PAID_ENABLED is the difference between a waitlist and a shop.
      // Closing checkout here is fail-closed: a Stripe key left in the
      // environment does not turn the sale back on.
      if (!config.CLOUD_PAID_ENABLED) {
        res.status(503).json({
          error: {
            code: 'CHECKOUT_DISABLED',
            message:
              'DOMINUS Cloud is not open for paid subscriptions yet. Join the waitlist from the landing page.',
          },
        });
        return;
      }

      const parsed = checkoutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid checkout request',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId ?? 'default';

      // The contract is formed here, not in Stripe. A payment without an
      // acceptance of the current text, the immediate-performance request
      // and (for a business) the art. 1341 c.c. approval must never start.
      const acceptance = parsed.data.contract ?? {
        documentVersion: '',
        contentHash: '',
        businessCustomer: false,
      };
      const contractService = getContractService();
      // index.ts always configures the ledger; in unit tests that mount the
      // router alone there is no ledger, and the acceptance check is skipped.
      // The boot guard and the guardrail assert the production wiring.
      if (config.CLOUD_PAID_ENABLED && contractService) {
        if (!acceptance.documentVersion || !acceptance.contentHash) {
          res.status(428).json({
            error: {
              code: 'CONTRACT_ACCEPTANCE_REQUIRED',
              message: 'Accept the terms and request immediate performance before checkout',
            },
          });
          return;
        }
        try {
          await contractService.requireCheckout({
            tenantId,
            version: acceptance.documentVersion,
            contentHash: acceptance.contentHash,
            needsArt1341: acceptance.businessCustomer,
          });
        } catch (err) {
          if (err instanceof ContractAcceptanceError) {
            res.status(428).json({
              error: {
                code: err.code,
                message: err.message,
              },
            });
            return;
          }
          throw err;
        }
      }

      // When PUBLIC_APP_URL is configured, redirect the payer back to our own
      // origin - never to an attacker-controlled URL. The comparison is on
      // the parsed origin: a prefix check would accept
      // 'https://dominus.app.attacker.tld'.
      const appOrigin = config.PUBLIC_APP_URL;
      if (appOrigin) {
        for (const field of ['successUrl', 'cancelUrl'] as const) {
          const url = parsed.data[field];
          if (!isAllowedAppUrl(url, appOrigin)) {
            res.status(400).json({
              error: {
                code: 'VALIDATION_ERROR',
                message: `${field} must be on the configured app origin (${appOrigin})`,
              },
            });
            return;
          }
        }
      }

      const session = await billingService.createCheckoutSession(
        tenantId,
        parsed.data.plan as SubscriptionPlan,
        parsed.data.interval as BillingInterval,
        parsed.data.successUrl,
        parsed.data.cancelUrl,
        req.auth?.userId,
        parsed.data.customPriceId,
      );

      if (!session) {
        res.status(400).json({
          error: {
            code: 'BILLING_NOT_CONFIGURED',
            message: 'Billing is not configured. Set STRIPE_SECRET_KEY to enable subscriptions.',
          },
        });
        return;
      }

      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const returnUrl =
        (req.body as { returnUrl?: string })?.returnUrl ??
        `${req.protocol}://${req.get('host')}/billing`;
      const appOrigin = config.PUBLIC_APP_URL;
      if (appOrigin && !isAllowedAppUrl(returnUrl, appOrigin)) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `returnUrl must be on the configured app origin (${appOrigin})`,
          },
        });
        return;
      }
      const session = await billingService.createPortalSession(tenantId, returnUrl);

      if (!session) {
        res.status(400).json({
          error: {
            code: 'NO_STRIPE_CUSTOMER',
            message: 'No Stripe customer found. Subscribe first.',
          },
        });
        return;
      }

      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Change the plan or cancel the subscription.
   *
   * The endpoint mutates the EXISTING Stripe subscription: a customer who
   * switches plan keeps one subscription and one invoice, and the plan is
   * granted when Stripe confirms the change through the webhook.
   */
  router.post('/subscription', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = subscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid subscription request',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId ?? 'default';

      if (parsed.data.action === 'change' && !config.CLOUD_PAID_ENABLED) {
        res.status(503).json({
          error: {
            code: 'CHECKOUT_DISABLED',
            message:
              'Plan changes are disabled until DOMINUS Cloud is open for paid subscriptions.',
          },
        });
        return;
      }

      if (!billingService.isConfigured) {
        res.status(400).json({
          error: {
            code: 'BILLING_NOT_CONFIGURED',
            message: 'Billing is not configured. Set STRIPE_SECRET_KEY to enable subscriptions.',
          },
        });
        return;
      }

      if (parsed.data.action === 'change') {
        // A plan change is a new contract act: the terms currently in force
        // must have been accepted before the subscription is mutated.
        const contractService = getContractService();
        if (config.CLOUD_PAID_ENABLED && contractService && parsed.data.contract) {
          try {
            await contractService.requireCheckout({
              tenantId,
              version: parsed.data.contract.documentVersion,
              contentHash: parsed.data.contract.contentHash,
              needsArt1341: parsed.data.contract.businessCustomer,
            });
          } catch (err) {
            if (err instanceof ContractAcceptanceError) {
              res.status(428).json({ error: { code: err.code, message: err.message } });
              return;
            }
            throw err;
          }
        }
        const changed = await billingService.changeSubscription(
          tenantId,
          parsed.data.plan as SubscriptionPlan,
          parsed.data.interval as BillingInterval,
        );
        if (!changed) {
          const subscription = await billingService.getSubscription(tenantId);
          if (!subscription.stripeSubscriptionId) {
            res.status(404).json({
              error: {
                code: 'NO_SUBSCRIPTION',
                message: 'This tenant has no subscription to change. Start one with checkout.',
              },
            });
            return;
          }
          res.status(400).json({
            error: {
              code: 'PRICE_NOT_CONFIGURED',
              message: 'The price for the requested plan and interval is not configured.',
            },
          });
          return;
        }
        res.json(changed);
        return;
      }

      const cancelled = await billingService.cancelSubscription(tenantId, parsed.data.mode);
      if (!cancelled) {
        res.status(404).json({
          error: {
            code: 'NO_SUBSCRIPTION',
            message: 'This tenant has no subscription to cancel.',
          },
        });
        return;
      }
      res.json(cancelled);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
