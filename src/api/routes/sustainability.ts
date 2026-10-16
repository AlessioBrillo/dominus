// SPDX-License-Identifier: AGPL-3.0-only
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PortfolioSustainabilityService } from '../../services/portfolio-sustainability-service.js';

/**
 * Carry-cost sustainability verdicts (ADR-0083, M5).
 *
 * Read-only surface over the recorded ad revenue and the portfolio carry
 * cost: what each held domain earns per year against what it costs to
 * renew. `GET /` returns the whole portfolio, `GET /:domain` one domain.
 */
export function createSustainabilityRouter(service: PortfolioSustainabilityService): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const verdicts = await service.getAllVerdicts();
      res.json({ verdicts });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:domain', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = req.params.domain;
      const domain = Array.isArray(raw) ? raw[0] : raw;
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'domain is required' } });
        return;
      }
      const verdict = await service.getDomainVerdict(domain);
      if (verdict === null) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Domain not in portfolio' } });
        return;
      }
      res.json({ verdict });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
