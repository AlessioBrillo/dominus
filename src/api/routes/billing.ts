// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { BillingInterval, BillingService } from '../../services/billing-service.js';
import type { Config } from '../../config.js';
import type { SubscriptionPlan } from '../../types/subscription.js';

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'team', 'enterprise']),
  interval: z.enum(['month', 'year']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  // Optional: custom price ID for enterprise custom pricing (admin use)
  customPriceId: z.string().optional(),
});

export function createBillingRouter(config: Config, billingService: BillingService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscription = await billingService.getSubscription(req.tenantId ?? 'default');
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
          available: billingService.isConfigured,
        },
        {
          id: 'team',
          name: 'Team',
          monthlyPriceId: billingService.resolvePriceId('team', 'month') ?? null,
          yearlyPriceId: billingService.resolvePriceId('team', 'year') ?? null,
          available: billingService.isConfigured,
        },
        {
          id: 'enterprise',
          name: 'Enterprise',
          monthlyPriceId: billingService.resolvePriceId('enterprise', 'month') ?? null,
          yearlyPriceId: billingService.resolvePriceId('enterprise', 'year') ?? null,
          available: billingService.isConfigured,
        },
      ];
      res.json({
        subscription,
        plans,
        isStripeConfigured: billingService.isConfigured,
        publishableKey: config.STRIPE_PUBLISHABLE_KEY ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/checkout', async (req: Request, res: Response, next: NextFunction) => {
    try {
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

      // When PUBLIC_APP_URL is configured, redirect the payer back to our own
      // origin — never to an attacker-controlled URL.
      const appOrigin = config.PUBLIC_APP_URL;
      if (appOrigin) {
        for (const field of ['successUrl', 'cancelUrl'] as const) {
          const url = parsed.data[field];
          if (!url.startsWith(appOrigin)) {
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
      if (appOrigin && !returnUrl.startsWith(appOrigin)) {
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

  return router;
}
