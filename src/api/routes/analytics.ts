import { Router } from 'express';
import type { PredictionAccuracyAnalyzer } from '../../analytics/index.js';
import type { PnlService } from '../../portfolio/index.js';

export function createAnalyticsRouter(
  accuracyAnalyzer: PredictionAccuracyAnalyzer,
  pnlService?: PnlService,
): Router {
  const router = Router();

  router.post('/refresh', (_req, res) => {
    try {
      const snapshot = accuracyAnalyzer.refresh();
      res.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'ANALYTICS_REFRESH_ERROR', message } });
    }
  });

  router.get('/accuracy', (_req, res) => {
    try {
      const report = accuracyAnalyzer.generate();
      res.json(report);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'ANALYTICS_ACCURACY_ERROR', message } });
    }
  });

  if (pnlService) {
    router.get('/pnl', (_req, res) => {
      try {
        const report = pnlService.generate();
        res.json(report);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: { code: 'PNL_ERROR', message } });
      }
    });
  }

  return router;
}
