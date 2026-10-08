// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction } from 'express';

/**
 * Gates a route to callers whose `req.auth.role` (set by createAuthMiddleware)
 * is in the allowed list. Must run after createAuthMiddleware. The platform
 * `operator` role satisfies every requirement (it is a superset of `admin`).
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.auth?.role;
    if (!role || (role !== 'operator' && !roles.includes(role))) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Insufficient role for this operation' },
      });
      return;
    }
    next();
  };
}
