// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AdminService } from '../../services/admin-service.js';
import { UsageMeterService } from '../../services/usage-meter-service.js';
import { requireRole } from '../middleware/require-role.js';
import type { SubscriptionPlan } from '../../types/subscription.js';

const tenantParam = z.string().min(1).max(128);
const suspendBody = z.object({
  reason: z.string().min(1).max(500).optional(),
});
const planOverrideBody = z.object({
  plan: z.enum(['free', 'pro', 'team', 'enterprise']).nullable(),
});
const customPriceBody = z.object({
  priceId: z.string().min(1).max(128),
  plan: z.enum(['pro', 'team', 'enterprise']),
  expectedAmountEur: z.number().int().min(1).max(1000000),
  seats: z.number().int().min(1).max(1000).default(1),
});
const daysParam = z.coerce.number().int().min(1).max(365).default(30);

/**
 * Platform admin surface (DOMINUS Cloud operators).
 *
 * Every route is gated on the `admin` role — a role that can only be
 * minted via the CLI key-management command (see api-keys route docs,
 * ADR-0032). The default community auth (env API keys) has no role, so
 * the admin surface is effectively disabled for self-hosted installs.
 *
 * Lifecycle endpoints (suspend/unsuspend/plan-override, ADR-0057) are the
 * operator abuse-response loop: they are deliberate human actions and the
 * only writers of the tenant_admin_flags control-plane table.
 */
export function createAdminRouter(adminService: AdminService): Router {
  const router = Router();
  router.use(requireRole('admin'));

  const periodStart = (): string => UsageMeterService.periodStart(new Date().toISOString());

  const parseTenant = (req: Request, res: Response): string | null => {
    const parsed = tenantParam.safeParse(req.params.tenantId);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid tenant identifier',
          issues: parsed.error.issues,
        },
      });
      return null;
    }
    return parsed.data;
  };

  router.get('/overview', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const overview = await adminService.overview(periodStart());
      res.json(overview);
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tenants = await adminService.listTenants(periodStart());
      res.json(tenants);
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = parseTenant(req, res);
      if (tenantId === null) return;

      const tenant = await adminService.tenantDetail(tenantId, periodStart());
      if (!tenant) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: `Tenant '${tenantId}' not found` },
        });
        return;
      }
      res.json(tenant);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/tenants/:tenantId/usage',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const days = daysParam.safeParse(req.query.days ?? 30);
        if (!days.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid days window (1-365)',
              issues: days.error.issues,
            },
          });
          return;
        }
        const fromIso = new Date(Date.now() - days.data * 24 * 60 * 60 * 1000).toISOString();
        const series = await adminService.tenantUsageSeries(tenantId, fromIso);
        res.json(series);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/tenants/:tenantId/suspend',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const body = suspendBody.safeParse(req.body ?? {});
        if (!body.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid suspend request',
              issues: body.error.issues,
            },
          });
          return;
        }

        const flag = await adminService.suspendTenant(tenantId, body.data.reason ?? null);
        res.json(flag);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/tenants/:tenantId/unsuspend',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const flag = await adminService.unsuspendTenant(tenantId);
        res.json(flag);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/tenants/:tenantId/plan-override',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const body = planOverrideBody.safeParse(req.body ?? {});
        if (!body.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid plan override request',
              issues: body.error.issues,
            },
          });
          return;
        }

        const plan: SubscriptionPlan | null = body.data.plan;
        const flag = await adminService.setPlanOverride(tenantId, plan);
        res.json(flag);
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Custom Price Management (Enterprise) ---

  router.get(
    '/tenants/:tenantId/custom-prices',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const prices = await adminService.listCustomPrices(tenantId);
        res.json(prices);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/custom-prices/:priceId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = tenantParam.safeParse(req.params.priceId);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid price identifier',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const price = await adminService.getCustomPrice(parsed.data);
      if (!price) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: `Custom price '${parsed.data}' not found` },
        });
        return;
      }
      res.json(price);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/tenants/:tenantId/custom-prices',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = parseTenant(req, res);
        if (tenantId === null) return;

        const body = customPriceBody.safeParse(req.body ?? {});
        if (!body.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid custom price request',
              issues: body.error.issues,
            },
          });
          return;
        }

        await adminService.upsertCustomPrice({
          tenantId,
          priceId: body.data.priceId,
          plan: body.data.plan,
          expectedAmountEur: body.data.expectedAmountEur,
          seats: body.data.seats,
        });
        res.status(201).json({ success: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/custom-prices/:priceId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = tenantParam.safeParse(req.params.priceId);
        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid price identifier',
              issues: parsed.error.issues,
            },
          });
          return;
        }

        const deleted = await adminService.deleteCustomPrice(parsed.data);
        if (!deleted) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: `Custom price '${parsed.data}' not found` },
          });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
