// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { RegistrarCatalogService } from '../../services/registrar-catalog-service.js';
import { validate } from '../middleware/validate.js';

const tldParamSchema = z.object({
  tld: z.string().min(1).max(20),
});

const domainQuerySchema = z.object({
  domain: z.string().min(1).max(253),
});

const holdingYearsQuerySchema = z.object({
  holdingYears: z.coerce.number().int().min(1).max(20).default(3),
});

export function createRegistrarCatalogRouter(registrarCatalog: RegistrarCatalogService): Router {
  const router = Router();

  /** All TLDs covered by the catalog. */
  router.get('/tlds', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ tlds: registrarCatalog.getTlds() });
    } catch (err) {
      next(err);
    }
  });

  /** All registrars in the catalog. */
  router.get(
    '/registrars',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json({ registrars: registrarCatalog.getRegistrars() });
      } catch (err) {
        next(err);
      }
    },
  );

  /** Price matrix for a TLD. */
  router.get(
    '/tlds/:tld',
    validate({ params: tldParamSchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { tld } = req.params as z.infer<typeof tldParamSchema>;
        const matrix = registrarCatalog.getTldMatrix(tld);
        if (!matrix) {
          res.status(404).json({
            error: { code: 'TLD_NOT_FOUND', message: `TLD ${tld} not in catalog` },
          });
          return;
        }
        res.json({ matrix });
      } catch (err) {
        next(err);
      }
    },
  );

  /** TCO comparison for a domain over a holding period. */
  router.get(
    '/tco',
    validate({ query: domainQuerySchema.merge(holdingYearsQuerySchema) }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, holdingYears } = req.query as unknown as z.infer<typeof domainQuerySchema> &
          z.infer<typeof holdingYearsQuerySchema>;
        const tco = registrarCatalog.computeTco(domain, holdingYears);
        res.json({ tco });
      } catch (err) {
        next(err);
      }
    },
  );

  /** Registrar recommendation for a domain. */
  router.get(
    '/recommend',
    validate({ query: domainQuerySchema.merge(holdingYearsQuerySchema) }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, holdingYears } = req.query as unknown as z.infer<typeof domainQuerySchema> &
          z.infer<typeof holdingYearsQuerySchema>;
        const rec = registrarCatalog.recommendRegistrar(domain, holdingYears);
        res.json({ recommendation: rec });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
