// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { JobWorker } from '../../jobs/worker.js';
import type { JobQueueService } from '../../app/job-queue-service.js';

export function createWorkerRouter(
  worker: JobWorker | undefined,
  jobQueueService: JobQueueService,
  gate: RequestHandler = (_req, _res, next) => next(),
): Router {
  const router = Router();

  // The queue is global: the stats and the recent dead letters are the work
  // of every tenant, and a dead letter carries the job type and the error of
  // somebody else's job. It is an operator surface, not a tenant one.
  router.use(gate);

  router.get('/worker', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workerStatus = worker?.getStatus() ?? { running: false, activeJobs: 0, concurrency: 0 };
      const queueStats = await jobQueueService.getQueueStats();
      const deadLetter = await jobQueueService.getDeadLetter({ limit: 5 });

      res.json({
        worker: workerStatus,
        queue: queueStats,
        deadLetterRecent: deadLetter.map((dl) => ({
          id: dl.id,
          jobType: dl.jobType,
          error: dl.error,
          attempts: dl.attempts,
          failedAt: dl.failedAt,
        })),
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
