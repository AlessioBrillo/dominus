import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';

export function createCandidatesRouter(
  runService: PipelineRunService,
  candidateRepo: CandidateRepository,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const candidates = candidateRepo.findByRunId('');
      res.json({ candidates });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/run', (req: Request, res: Response, next: NextFunction): void => {
    const { keywords, brandableNames, closeoutDomains } = req.body as {
      keywords?: string[];
      brandableNames?: string[];
      closeoutDomains?: string[];
    };

    runService
      .run({ keywords, brandableNames, closeoutDomains })
      .then((result) => {
        res.json({
          runId: result.runId,
          recommended: result.recommended,
          stageSummary: result.stageSummary,
          totalDurationMs: result.totalDurationMs,
          persistence: result.persistence,
        });
      })
      .catch((err: unknown) => next(err));
  });

  return router;
}
