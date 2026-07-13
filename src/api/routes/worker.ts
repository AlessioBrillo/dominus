import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { JobWorker } from '../../jobs/worker.js';
import type { JobQueueService } from '../../app/job-queue-service.js';

export function createWorkerRouter(
  worker: JobWorker | undefined,
  jobQueueService: JobQueueService,
): Router {
  const router = Router();

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
