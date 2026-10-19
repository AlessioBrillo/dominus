// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { TenantDataService } from '../../services/tenant-data-service.js';
import { requireRole } from '../middleware/require-role.js';

/**
 * Data-subject rights (GDPR art. 15 and 17).
 *
 * Both operations concern the whole tenant, not one user's rows: the
 * service holds the team's data, so the caller must be a tenant admin. The
 * tenant is never taken from the request body — it is the tenant the
 * request was authenticated for.
 */
const deleteSchema = z.object({
  /**
   * The tenant id, echoed back by the caller. A deletion that cannot be
   * tied to a deliberate confirmation is an accident waiting to happen, so
   * the caller has to type the id.
   */
  confirm: z.string().min(1).max(128),
});

export function createTenantDataRouter(tenantDataService: TenantDataService): Router {
  const router = Router();

  router.get(
    '/export',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const tenantId = req.tenantId ?? 'default';
        res.json(await tenantDataService.exportTenant(tenantId));
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.delete(
    '/',
    requireRole('admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const tenantId = req.tenantId ?? 'default';
        const parsed = deleteSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request body failed validation',
              issues: parsed.error.issues,
            },
          });
          return;
        }
        if (parsed.data.confirm !== tenantId) {
          res.status(400).json({
            error: {
              code: 'CONFIRMATION_MISMATCH',
              message: 'The confirmation must be the tenant id of the tenant being deleted',
            },
          });
          return;
        }
        res.json(await tenantDataService.deleteTenant(tenantId));
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  return router;
}
