// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { MobileDeviceRepository } from '../../db/repositories/mobile-device-repository.js';
import type { PushSubscriptionRepository } from '../../db/repositories/push-subscription-repository.js';
import type { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import type { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import type { WatchlistRepository } from '../../db/repositories/watchlist-repository.js';
import {
  DEVICE_TOKEN_PREFIX,
  hashDeviceToken,
} from '../../providers/auth/device-token-provider.js';
import { getRouteParam } from '../route-utils.js';
import { validate } from '../middleware/validate.js';

const deviceSchema = z.object({
  label: z.string().min(1).max(80).default('This device'),
});

const subscriptionSchema = z.object({
  platform: z.enum(['web', 'android', 'ios']),
  endpoint: z.string().url().max(2000),
  p256dh: z.string().max(512).optional(),
  auth: z.string().max(512).optional(),
  // A literal `datetime()` here would trip the SQL portability scanner.
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'ISO-8601 UTC timestamp')
    .optional(),
  topics: z
    .object({
      renewal: z.boolean().default(true),
      watchlist: z.boolean().default(true),
      verdict: z.boolean().default(true),
    })
    .default({ renewal: true, watchlist: true, verdict: true }),
});

export interface MobileRouterDeps {
  deviceRepo: MobileDeviceRepository;
  pushRepo: PushSubscriptionRepository;
  alertRepo: RenewalAlertRepository;
  portfolioRepo: PortfolioRepository;
  watchlistRepo: WatchlistRepository;
  /** Absent = the browser cannot subscribe; the client hides the push button. */
  vapidPublicKey?: string | undefined;
  /** True only for a real comparables provider, never the bundled sample (ADR-0115). */
  marketDataAvailable: boolean;
}

/** The three decision jobs of the mobile shell (ADR-0114, ADR-0117). */
export function createMobileRouter(deps: MobileRouterDeps): Router {
  const router = Router();

  router.get('/today', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [alerts, portfolio, watchlist] = await Promise.all([
        deps.alertRepo.findAll(undefined, true),
        deps.portfolioRepo.findAll(),
        deps.watchlistRepo.list(),
      ]);
      const now = Date.now();
      const in30Days = now + 30 * 24 * 60 * 60 * 1000;

      const decisions: Array<{
        id: string;
        type: string;
        domain: string;
        title: string;
        detail: string;
        severity: string;
        href: string;
      }> = alerts.map((alert) => ({
        id: `alert-${alert.id}`,
        type: 'alert',
        domain: alert.domain,
        title: alert.message,
        detail: `Renewal and portfolio decision · ${alert.createdAt}`,
        severity: alert.severity,
        href: '/alerts',
      }));

      for (const entry of portfolio) {
        const renewal = new Date(entry.renewalDate).getTime();
        if (
          Number.isFinite(renewal) &&
          renewal <= in30Days &&
          renewal >= now - 24 * 60 * 60 * 1000
        ) {
          decisions.push({
            id: `renewal-${entry.id}`,
            type: 'renewal',
            domain: entry.domain,
            title: renewal <= now ? 'Renewal date passed' : 'Renewal coming up',
            detail: `Current verdict: ${entry.verdict}`,
            severity: renewal <= now ? 'critical' : 'warning',
            href: '/portfolio',
          });
        }
      }

      for (const entry of watchlist) {
        if (entry.lastStatus === 'available') {
          decisions.push({
            id: `watch-${entry.id}`,
            type: 'watchlist',
            domain: entry.domain,
            title: 'Watchlist domain may be available',
            detail: 'Confirm with the scoring engine before acting.',
            severity: 'info',
            href: '/watchlist',
          });
        }
      }

      decisions.sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
        return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
      });

      res.json({
        generatedAt: new Date().toISOString(),
        decisions: decisions.slice(0, 20),
        summary: {
          portfolioDomains: portfolio.length,
          activeAlerts: alerts.length,
          watchlistSize: watchlist.length,
        },
        // ADR-0115: the value contract is the method, so the UI says which
        // evidence is available instead of implying a precise appraisal.
        evidence: {
          marketDataAvailable: deps.marketDataAvailable,
          note: 'Estimates are based on available signals. This is not an appraisal or investment advice.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/devices',
    validate({ body: deviceSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = req.tenantId ?? 'default';
        const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
        const device = await deps.deviceRepo.create({
          tenantId,
          label: (req.body as z.infer<typeof deviceSchema>).label,
          tokenHash: hashDeviceToken(token),
        });
        res.status(201).json({ device, token });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/devices', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ devices: await deps.deviceRepo.list(req.tenantId ?? 'default') });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/devices/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(getRouteParam(req, 'id'));
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid device id' } });
        return;
      }
      const tenantId = req.tenantId ?? 'default';
      const revoked = await deps.deviceRepo.revoke(id, tenantId);
      if (!revoked) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
        return;
      }
      await deps.pushRepo.revokeForDevice(id, tenantId);
      res.json({ revoked: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/push', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      res.json({
        vapidPublicKey: deps.vapidPublicKey ?? null,
        enabled: deps.vapidPublicKey !== undefined,
        subscriptions: await deps.pushRepo.list(tenantId),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/push',
    validate({ body: subscriptionSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.vapidPublicKey) {
          res.status(404).json({
            error: {
              code: 'PUSH_NOT_CONFIGURED',
              message: 'Web push is not configured (VAPID keys are missing)',
            },
          });
          return;
        }
        const body = req.body as z.infer<typeof subscriptionSchema>;
        if (body.platform === 'web' && (!body.p256dh || !body.auth)) {
          res.status(400).json({
            error: {
              code: 'INVALID_SUBSCRIPTION',
              message: 'A web subscription requires p256dh and auth keys',
            },
          });
          return;
        }
        const subscription = await deps.pushRepo.upsert({
          platform: body.platform,
          endpoint: body.endpoint,
          ...(body.p256dh ? { p256dh: body.p256dh } : {}),
          ...(body.auth ? { auth: body.auth } : {}),
          ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
          topics: body.topics,
        });
        res.json({ subscription });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete('/push/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(getRouteParam(req, 'id'));
      if (!Number.isInteger(id) || id <= 0) {
        res
          .status(400)
          .json({ error: { code: 'BAD_REQUEST', message: 'Invalid subscription id' } });
        return;
      }
      const removed = await deps.pushRepo.remove(id, req.tenantId ?? 'default');
      if (!removed) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
        return;
      }
      res.json({ removed: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
