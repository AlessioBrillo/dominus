// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { PostAcquisitionService } from '../../services/post-acquisition-service.js';
import { POST_ACQUISITION_STEPS } from '../../types/automation.js';
import { validate } from '../middleware/validate.js';

const stepsQuerySchema = z.object({
  domain: z.string().max(253).optional(),
  status: z.enum(['pending', 'done', 'skipped', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const runBodySchema = z.object({
  domain: z.string().min(1).max(253),
  source: z.enum(['purchase', 'acquisition', 'manual', 'pipeline_run']).default('manual'),
  pipelineRunId: z.string().max(64).nullable().optional(),
});

const resetBodySchema = z.object({
  domain: z.string().min(1).max(253),
  step: z.enum(POST_ACQUISITION_STEPS).optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function createAutomationRouter(postAcquisitionService: PostAcquisitionService): Router {
  const router = Router();

  router.get('/settings', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ settings: postAcquisitionService.settings });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/steps',
    validate({ query: stepsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, status, limit } = req.query as unknown as z.infer<typeof stepsQuerySchema>;
        const steps = domain
          ? await postAcquisitionService.getStatus(domain)
          : await postAcquisitionService.listSteps({
              ...(status !== undefined ? { status } : {}),
              limit,
            });
        res.json({ steps });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/audit',
    validate({ query: auditQuerySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { limit } = req.query as unknown as z.infer<typeof auditQuerySchema>;
        const entries = await postAcquisitionService.listAudit(limit);
        res.json({ entries });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/run',
    validate({ body: runBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, source, pipelineRunId } = req.body as z.infer<typeof runBodySchema>;
        const result = await postAcquisitionService.run(domain, source, {
          ...(pipelineRunId != null ? { pipelineRunId } : {}),
        });
        if (!result.enabled) {
          res.status(409).json({
            error:
              'Automation is disabled (AUTOMATION_ENABLED=false). Enable the kill switch before running the pipeline.',
            code: 'AUTOMATION_DISABLED',
          });
          return;
        }
        res.json({ result });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/reset',
    validate({ body: resetBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, step } = req.body as z.infer<typeof resetBodySchema>;
        if (step !== undefined) {
          await postAcquisitionService.resetStep(domain, step);
          res.json({ domain, step, status: 'pending' });
          return;
        }
        const result = await postAcquisitionService.resetAndRun(domain, 'manual');
        res.json({ domain, result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
