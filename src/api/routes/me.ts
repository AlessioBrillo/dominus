// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response } from 'express';

/**
 * Who the API thinks the caller is. The SPA uses it to decide what to show
 * (e.g. the operator panel only for `operator`); it is a hint for the UI, not
 * an authorization boundary — every route still enforces its own role gate.
 *
 * Mounted behind the auth middleware, so `role` is the effective role
 * (operator allowlist applied), for API keys and SSO sessions alike.
 */
export function createMeRouter(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    res.json({
      tenantId: req.tenantId ?? 'default',
      role: req.auth?.role ?? null,
      userId: req.auth?.userId ?? null,
      keyName: req.auth?.keyName ?? null,
    });
  });

  return router;
}
