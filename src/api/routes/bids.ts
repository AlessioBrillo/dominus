import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AcquisitionService } from '../../services/acquisition-service.js';
import { BidStatus, isBidStatus } from '../../types/acquisition.js';
import { validate } from '../middleware/validate.js';

const placeBidSchema = z.object({
  domain: z.string().min(1).max(253),
  venue: z.string().min(1).max(100).default('private'),
  bidAmountEur: z.number().positive(),
  maxBidEur: z.number().positive().optional(),
  auctionEndsAt: z.string().optional(),
  expectedValueAtBid: z.number().nonnegative().optional(),
  confidenceAtBid: z.number().min(0).max(1).optional(),
  suggestedBuyMaxAtBid: z.number().nonnegative().optional(),
  trademarkClearAtBid: z.boolean().optional(),
  notes: z.string().optional(),
});

const resolveBidSchema = z.object({
  domain: z.string().min(1).max(253),
  status: z.enum(['won', 'lost', 'cancelled', 'outbid']),
  wonPriceEur: z.number().nonnegative().optional(),
  registrationYears: z.number().int().min(1).max(10).optional(),
  notes: z.string().optional(),
});

function toBidStatusEnum(
  s: string,
): BidStatus.Won | BidStatus.Lost | BidStatus.Cancelled | BidStatus.Outbid {
  switch (s) {
    case 'won':
      return BidStatus.Won;
    case 'lost':
      return BidStatus.Lost;
    case 'cancelled':
      return BidStatus.Cancelled;
    case 'outbid':
      return BidStatus.Outbid;
    default:
      throw new Error(`Invalid bid status: ${s}`);
  }
}

export function createBidsRouter(acquisitionService: AcquisitionService): Router {
  const router = Router();

  router.post(
    '/place',
    validate({ body: placeBidSchema }),
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      try {
        const bid = await acquisitionService.place(req.body as z.infer<typeof placeBidSchema>);
        res.status(201).json({ bid });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(409).json({ error: { code: 'BID_CONFLICT', message } });
      }
    },
  );

  router.post(
    '/resolve',
    validate({ body: resolveBidSchema }),
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      try {
        const body = req.body as z.infer<typeof resolveBidSchema>;
        const bid = await acquisitionService.resolve({
          domain: body.domain,
          status: toBidStatusEnum(body.status),
          wonPriceEur: body.wonPriceEur,
          registrationYears: body.registrationYears,
          notes: body.notes,
        });
        res.json({ bid });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(409).json({ error: { code: 'BID_RESOLVE_ERROR', message } });
      }
    },
  );

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const statusParam = req.query['status'] as string | undefined;
      const status =
        statusParam !== undefined && isBidStatus(statusParam)
          ? (statusParam as BidStatus)
          : undefined;
      const bids = await acquisitionService.list(status);
      res.json({ bids });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/pending',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const bids = await acquisitionService.pending();
        res.json({ bids });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/:domain', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const domain = req.params['domain'] as string;
      const bid = await acquisitionService.get(domain);
      if (bid === null) {
        res.status(404).json({
          error: { code: 'BID_NOT_FOUND', message: `No bid found for domain: ${domain}` },
        });
        return;
      }
      res.json({ bid });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
