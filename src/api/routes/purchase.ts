import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { PurchaseService } from '../../services/purchase-service.js';
import { PurchaseNotApprovedError } from '../../types/registrar.js';
import { validate } from '../middleware/validate.js';

const preflightQuerySchema = z.object({
  domain: z.string().min(1).max(253),
});

const purchaseBodySchema = z.object({
  domain: z.string().min(1).max(253),
  years: z.number().int().min(1).max(10).default(1),
  operatorApproved: z.boolean().default(false),
});

const priceQuerySchema = z.object({
  domains: z.string().min(1),
});

export function createPurchaseRouter(purchaseService: PurchaseService): Router {
  const router = Router();

  router.get(
    '/preflight',
    validate({ query: preflightQuerySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const domain = (req.query['domain'] as string) ?? '';
        const check = await purchaseService.preflight(domain);
        res.json({ check });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/execute',
    validate({ body: purchaseBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { domain, years, operatorApproved } = req.body as z.infer<typeof purchaseBodySchema>;
        const result = await purchaseService.execute(domain, years, operatorApproved);
        if (result.success) {
          res.json({ success: true, purchase: result.purchase, message: result.message });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (err) {
        if (err instanceof PurchaseNotApprovedError) {
          res
            .status(400)
            .json({ success: false, error: err.message, code: 'PURCHASE_NOT_APPROVED' });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/price',
    validate({ query: priceQuerySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const domainsStr = (req.query['domains'] as string) ?? '';
        const domains = domainsStr
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);
        const prices = await purchaseService.checkPrice(domains);
        res.json({ prices });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
