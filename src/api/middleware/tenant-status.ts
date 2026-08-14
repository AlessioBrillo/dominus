// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction } from 'express';
import type { AdminRepository } from '../../db/repositories/admin-repository.js';

/**
 * Routes a suspended tenant may still reach: the billing surface, so a
 * tenant can pay their invoice / open the Stripe customer portal and
 * recover (ADR-0057 payment escape hatch). Everything else is blocked.
 */
const ALLOWED_PREFIXES = ['/billing'];

/**
 * Fail-closed suspension gate for the protected API (ADR-0057).
 *
 * Mounted right after authentication. When the tenant has an operator
 * suspension flag, every request is rejected with 403 TENANT_SUSPENDED
 * except the /billing subtree (payment escape hatch) and callers holding
 * the `admin` role (operator keys must keep working).
 *
 * Community edition: the flag table is empty (flags are only ever written
 * through the admin-role surface), so this middleware is a single indexed
 * PK lookup that always passes — zero behavior change.
 */
export function createTenantStatusMiddleware(adminRepo: AdminRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.auth?.role === 'admin') {
      next();
      return;
    }

    if (ALLOWED_PREFIXES.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }

    const tenantId = req.tenantId ?? 'default';
    const flag = await adminRepo.getAdminFlag(tenantId);
    if (flag?.suspendedAt) {
      res.status(403).json({
        error: {
          code: 'TENANT_SUSPENDED',
          message: `Tenant '${tenantId}' is suspended. Contact the platform operator.`,
          context: { tenantId },
        },
      });
      return;
    }

    next();
  };
}
