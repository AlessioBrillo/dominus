import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { WatchlistService } from '../../watchlist/watchlist-service.js';
import { getRouteParam } from '../route-utils.js';

const addInputSchema = z.object({
  domain: z.string().min(1).max(255),
  notes: z.string().optional(),
});

function parseZodError(err: z.ZodError): { code: string; message: string; issues: unknown } {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request body failed validation',
    issues: err.issues,
  };
}

export function createWatchlistRouter(watchlistService: WatchlistService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const entries = watchlistService.list();
      res.json({ entries });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/:domain', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing domain parameter' } });
        return;
      }
      const entry = watchlistService.get(domain);
      if (entry === null) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Domain ${domain} not found in watchlist` } });
        return;
      }
      res.json({ entry });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = addInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parseZodError(parsed.error) });
        return;
      }
      const { domain, notes } = parsed.data;
      const entry = watchlistService.add(domain, notes);
      res.status(201).json({ entry });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        res.status(409).json({ error: { code: 'CONFLICT', message: `Domain ${req.body.domain} is already in the watchlist` } });
        return;
      }
      next(err);
    }
  });

  router.delete('/:domain', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing domain parameter' } });
        return;
      }
      const removed = watchlistService.remove(domain);
      if (!removed) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Domain ${domain} not found in watchlist` } });
        return;
      }
      res.json({ removed: true });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/poll', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await watchlistService.poll();
      res.json(result);
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
