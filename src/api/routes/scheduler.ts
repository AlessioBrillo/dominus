import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
import { getRouteParam } from '../route-utils.js';

export function createSchedulerRouter(scheduler: SchedulerService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const jobs = scheduler.getStatus();
      res.json({ jobs });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/run/:job', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const job = getRouteParam(req, 'job');
      if (job === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Job name is required' } });
        return;
      }
      scheduler
        .runOnce(job)
        .then((result) => {
          res.json({ job, result });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          res.status(404).json({ error: { code: 'UNKNOWN_JOB', message } });
        });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
