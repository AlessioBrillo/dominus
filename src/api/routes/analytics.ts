import { Router } from 'express';
import type { NextFunction } from 'express';
import type { PredictionAccuracyAnalyzer } from '../../analytics/index.js';
import type { PnlService } from '../../portfolio/index.js';

export function createAnalyticsRouter(
  accuracyAnalyzer: PredictionAccuracyAnalyzer,
  pnlService?: PnlService,
): Router {
  const router = Router();

  router.post('/refresh', async (_req, res, next: NextFunction) => {
    try {
      const snapshot = await accuracyAnalyzer.refresh();
      res.json(snapshot);
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/accuracy', (_req, res, next: NextFunction) => {
    try {
      const report = accuracyAnalyzer.generate();
      res.json(report);
    } catch (err: unknown) {
      next(err);
    }
  });

  if (pnlService) {
    router.get('/pnl', async (_req, res, next: NextFunction) => {
      try {
        const report = await pnlService.generate();
        res.json(report);
      } catch (err: unknown) {
        next(err);
      }
    });
  }

  return router;
}
