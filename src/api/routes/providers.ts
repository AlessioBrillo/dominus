import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../../config.js';
import { reportProviderStatuses } from '../../app/provider-status.js';

export function createProvidersRouter(config: Config): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const statuses = reportProviderStatuses(config);
      res.json({ providers: statuses });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
