import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { isOutcomeType } from '../../types/outcome.js';
import { ConfigError } from '../../types/errors.js';
import { getRouteParam } from '../route-utils.js';

const portfolioInputSchema = z.object({
  domain: z.string().min(1).max(255),
  tld: z.string().min(1).max(255),
  acquiredAt: z.string().min(1),
  renewalDate: z.string().min(1),
  acquisitionCost: z.number().nonnegative(),
  renewalCost: z.number().nonnegative(),
  registrar: z.string().min(1).max(255),
  notes: z.string().optional(),
});

const outcomeInputSchema = z.object({
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

export function createPortfolioRouter(
  manager: PortfolioManager,
  outcomeRepo: OutcomeRepository,
): Router {
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
      const parsed = portfolioInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parseZodError(parsed.error) });
        return;
      }
      const entry = manager.add(parsed.data);
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
      const domain = getRouteParam(req, 'domain');
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

  router.post('/rescore', (_req: Request, res: Response, next: NextFunction): void => {
    manager
      .rescoreAll()
      .then((summary) => {
        res.json({
          totalDurationMs: summary.totalDurationMs,
          results: summary.results.map((r) => ({
            domain: r.domain,
            calibratedScore: r.calibratedScore,
            suggestedListPrice: r.suggestedListPrice,
            expectedValue: r.expectedValue,
            confidence: r.confidence,
            trademarkClear: r.trademarkClear,
            trademarkVerdict: r.trademarkVerdict,
            verifiedSources: r.verifiedSources,
            matchedMark: r.matchedMark,
            error: r.error,
          })),
        });
      })
      .catch(next);
  });

  router.get('/:domain/outcomes', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'domain is required' } });
        return;
      }
      const outcomes = outcomeRepo.findByDomain(domain);
      res.json({ outcomes });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/:domain/outcomes/stats', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'domain is required' } });
        return;
      }
      const stats = outcomeRepo.statsByDomain(domain);
      res.json({ domain, stats });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/:domain/outcomes', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const domain = getRouteParam(req, 'domain');
      if (domain === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'domain is required' } });
        return;
      }

      const parsed = outcomeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parseZodError(parsed.error) });
        return;
      }

      const outcome = outcomeRepo.insert({
        domain,
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
      // Map "domain not in portfolio" FK violation to 404 at the edge.
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ConfigError) {
        res.status(500).json({ error: { code: err.code, message: err.message } });
        return;
      }
      if (/not found in portfolio/i.test(message)) {
        res.status(404).json({ error: { code: 'DOMAIN_NOT_FOUND', message } });
        return;
      }
      next(err);
    }
  });

  return router;
}
