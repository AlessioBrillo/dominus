import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { CloseoutEntry } from '../../types/candidate.js';
import { validate } from '../middleware/validate.js';

const runBodySchema = z.object({
  keywords: z.array(z.string()).optional(),
  brandableNames: z.array(z.string()).optional(),
  closeoutDomains: z.array(z.string()).optional(),
  closeoutEntries: z
    .array(
      z.object({
        domain: z.string().min(1),
        domainAge: z.number().optional(),
        backlinks: z.number().optional(),
        waybackSnapshots: z.number().optional(),
      }),
    )
    .optional(),
});

export function createCandidatesRouter(
  runService: PipelineRunService,
  candidateRepo: CandidateRepository,
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = typeof req.query['runId'] === 'string' ? req.query['runId'] : '';
      if (runId === '') {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'runId query parameter is required' },
        });
        return;
      }
      const candidates = await candidateRepo.findByRunId(runId);
      res.json({ candidates });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post(
    '/run',
    validate({ body: runBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as z.infer<typeof runBodySchema>;

        const result = await runService.runSync({
          keywords: body.keywords,
          brandableNames: body.brandableNames,
          closeoutDomains: body.closeoutDomains,
          closeoutEntries: body.closeoutEntries as CloseoutEntry[] | undefined,
        });

        res.json({
          runId: result.runId,
          recommended: result.recommended,
          stageSummary: result.stageSummary,
          totalDurationMs: result.totalDurationMs,
          persistence: result.persistence,
        });
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  return router;
}
