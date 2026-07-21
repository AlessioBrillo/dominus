import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AcquisitionFunnelService } from '../../services/acquisition-funnel-service.js';

export function createFunnelRouter(funnelService: AcquisitionFunnelService): Router {
  const router = Router();

  router.get('/:runId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = req.params.runId as string;
      const result = await funnelService.getFunnel(runId);
      if (!result || result.entries.length === 0) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: `No funnel found for run ${runId}` },
        });
        return;
      }
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:runId/generate',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const runId = req.params.runId as string;
        const overrides: {
          budget?: number;
          minConfidence?: number;
          minBuyMax?: number;
          maxEntries?: number;
        } = {};
        if (typeof req.body?.budget === 'number') overrides.budget = req.body.budget;
        if (typeof req.body?.minConfidence === 'number')
          overrides.minConfidence = req.body.minConfidence;
        if (typeof req.body?.minBuyMax === 'number') overrides.minBuyMax = req.body.minBuyMax;
        if (typeof req.body?.maxEntries === 'number') overrides.maxEntries = req.body.maxEntries;

        const result = await funnelService.generateFunnel(runId, overrides);
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
