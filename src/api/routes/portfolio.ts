import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AddPortfolioEntryInput } from '../../types/portfolio.js';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';

export function createPortfolioRouter(manager: PortfolioManager): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const entries = manager.list();
      res.json({ portfolio: entries });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const input = req.body as unknown as AddPortfolioEntryInput;
      const entry = manager.add(input);
      res.status(201).json({ entry });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.patch('/:domain/verdict', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      manager.refreshVerdicts();
      res.json({ ok: true });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.delete('/:domain', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = req.params['domain'];
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'domain is required' } });
        return;
      }
      manager.remove(domain);
      res.status(204).send();
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
