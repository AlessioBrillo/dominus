import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { MetricsRepository } from '../../db/repositories/metrics-repository.js';
import type { MetricsCollector } from '../../app/metrics-collector.js';
import { getRouteParam } from '../route-utils.js';

export function createMetricsRouter(
  metricsRepo: MetricsRepository,
  collector: MetricsCollector,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const snapshot = collector.snapshot();
      const aggregates = metricsRepo.getAggregates();
      res.json({
        current: snapshot,
        aggregates,
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/runs', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const limitRaw =
        typeof req.query['limit'] === 'string' ? Number.parseInt(req.query['limit'], 10) : 20;
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;
      const history = metricsRepo.findRecentRuns(limit);
      res.json({ runs: history });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/runs/:runId', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const runId = getRouteParam(req, 'runId');
      if (!runId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required' } });
        return;
      }
      const stages = metricsRepo.findByRunId(runId);
      res.json({ runId, stages });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
