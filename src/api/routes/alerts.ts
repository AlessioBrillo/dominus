import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';
import { getRouteParam } from '../route-utils.js';

const acknowledgeQuerySchema = z.object({
  domain: z.string().optional(),
});

interface AlertRouteDeps {
  alertRepo: RenewalAlertRepository;
  alertEngine?: RenewalAlertEngine;
}

export function createAlertsRouter(deps: AlertRouteDeps): Router {
  const router = Router();
  const { alertRepo, alertEngine } = deps;

  router.get('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
      const unacknowledged =
        typeof req.query.unacknowledged === 'string'
          ? req.query.unacknowledged === 'true'
          : false;
      const alerts = alertRepo.findAll(domain, unacknowledged);
      res.json({ alerts });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post(
    '/:id/acknowledge',
    (req: Request, res: Response, next: NextFunction): void => {
      try {
        const id = Number(getRouteParam(req, 'id'));
        if (Number.isNaN(id) || id <= 0) {
          res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid alert ID' } });
          return;
        }
        const existing = alertRepo.findById(id);
        if (existing === null) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: `Alert ${id} not found` } });
          return;
        }
        alertRepo.acknowledge(id);
        const updated = alertRepo.findById(id);
        res.json({ alert: updated });
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.post('/acknowledge-all', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = acknowledgeQuerySchema.safeParse(req.body);
      const domain = parsed.success ? parsed.data.domain : undefined;
      const n = alertRepo.acknowledgeAll(domain);
      res.json({ acknowledged: n });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/run', (_req: Request, res: Response, next: NextFunction): void => {
    if (!alertEngine) {
      res.status(503).json({
        error: { code: 'UNAVAILABLE', message: 'Alert engine not configured' },
      });
      return;
    }
    alertEngine
      .checkAll()
      .then((result) => {
        res.json({ generated: result.generated, alerts: result.alerts });
      })
      .catch(next);
  });

  return router;
}
