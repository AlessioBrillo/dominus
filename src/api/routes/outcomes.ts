import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { isOutcomeType } from '../../types/outcome.js';
import { getRouteParam } from '../route-utils.js';

const outcomeInputSchema = z.object({
  domain: z.string().min(1),
  type: z.string().refine(isOutcomeType, {
    message: 'type must be one of: sold, dropped, expired, renewed',
  }),
  occurredAt: z.string().min(1),
  salePriceEur: z.number().nonnegative().optional(),
  listingPriceEur: z.number().nonnegative().optional(),
  daysListed: z.number().int().nonnegative().optional(),
  venue: z.string().optional(),
  commissionPct: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

function parseZodError(err: z.ZodError): { code: string; message: string; issues: unknown } {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request body failed validation',
    issues: err.issues,
  };
}

export function createOutcomesRouter(outcomeRepo: OutcomeRepository): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const type = typeof req.query['type'] === 'string' ? req.query['type'] : undefined;
      const outcomes =
        type !== undefined && isOutcomeType(type)
          ? outcomeRepo.findByType(type)
          : outcomeRepo.findAll();
      res.json({ outcomes });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = outcomeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parseZodError(parsed.error) });
        return;
      }

      const outcome = outcomeRepo.insert({
        domain: parsed.data.domain,
        type: parsed.data.type,
        occurredAt: new Date(parsed.data.occurredAt).toISOString(),
        salePriceEur: parsed.data.salePriceEur,
        listingPriceEur: parsed.data.listingPriceEur,
        daysListed: parsed.data.daysListed,
        venue: parsed.data.venue,
        commissionPct: parsed.data.commissionPct,
        notes: parsed.data.notes,
      });

      res.status(201).json({ outcome });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found in portfolio/i.test(message)) {
        res.status(404).json({ error: { code: 'DOMAIN_NOT_FOUND', message } });
        return;
      }
      next(err);
    }
  });

  router.get('/stats/:domain', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined || domain === '') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'domain is required' } });
        return;
      }
      const stats = outcomeRepo.statsByDomain(domain);
      res.json({ domain, stats });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
