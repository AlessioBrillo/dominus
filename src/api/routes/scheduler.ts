// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
import { getRouteParam } from '../route-utils.js';

export function createSchedulerRouter(
  scheduler: SchedulerService,
  gate: RequestHandler = (_req, _res, next) => next(),
): Router {
  const router = Router();

  // The scheduler drives the work of every tenant: it is an operator
  // surface. Without a gate, any authenticated member of any tenant could
  // fire a platform-wide job (and, in the tenant-scoped jobs, the work of
  // every other customer).
  router.use(gate);

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // getStatus() is asynchronous: without the await, the response carried
      // a pending promise (an empty object) and the page showed no job at
      // all.
      const jobs = await scheduler.getStatus();
      res.json({ jobs });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post(
    '/run/:job',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const job = getRouteParam(req, 'job');
        if (job === undefined) {
          res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Job name is required' } });
          return;
        }
        const result = await scheduler.runOnce(job);
        res.json({ job, result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('Unknown job:')) {
          res.status(404).json({ error: { code: 'UNKNOWN_JOB', message } });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
