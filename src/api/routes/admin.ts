// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AdminService } from '../../services/admin-service.js';
import { UsageMeterService } from '../../services/usage-meter-service.js';
import { requireRole } from '../middleware/require-role.js';

const tenantParam = z.string().min(1).max(128);

/**
 * Platform admin surface (DOMINUS Cloud operators).
 *
 * Every route is gated on the `admin` role — a role that can only be
 * minted via the CLI key-management command (see api-keys route docs,
 * ADR-0032). The default community auth (env API keys) has no role, so
 * the admin surface is effectively disabled for self-hosted installs.
 */
export function createAdminRouter(adminService: AdminService): Router {
  const router = Router();
  router.use(requireRole('admin'));

  const periodStart = (): string => UsageMeterService.periodStart(new Date().toISOString());

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
      const parsed = tenantParam.safeParse(req.params.tenantId);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid tenant identifier',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenants = await adminService.listTenants(periodStart());
      const tenant = tenants.find((t) => t.tenantId === parsed.data);
      if (!tenant) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: `Tenant '${parsed.data}' not found` },
        });
        return;
      }
      res.json(tenant);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
