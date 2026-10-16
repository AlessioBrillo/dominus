// SPDX-License-Identifier: AGPL-3.0-only
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { ListingManager } from '../../listing/listing-manager.js';
import type { TenantListingSettingsRepository } from '../../db/repositories/tenant-listing-settings-repository.js';
import type { TenantListingSettingsUpdate } from '../../types/listing-settings.js';
import { validate } from '../middleware/validate.js';

function parseId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 && Number.isInteger(id) ? id : null;
}

const settingsUpdateSchema = z
  .object({
    pricePolicy: z.enum(['scoring', 'fixed']),
    basePriceEur: z.number().positive().nullable(),
    offerAutoDeclineBelowEur: z.number().positive().nullable(),
    offerCounterEur: z.number().positive().nullable(),
  })
  .partial()
  .refine(
    (value) =>
      value.pricePolicy !== undefined ||
      value.basePriceEur !== undefined ||
      value.offerAutoDeclineBelowEur !== undefined ||
      value.offerCounterEur !== undefined,
    { message: 'At least one setting must be provided' },
  )
  // A fixed-price policy without a usable base price would silently fall
  // back to the scoring price and misreport the tenant's intent; €0 would
  // auto-list at zero.
  .refine(
    (value) =>
      value.pricePolicy !== 'fixed' ||
      (typeof value.basePriceEur === 'number' && value.basePriceEur > 0),
    { message: 'A fixed price policy requires basePriceEur above zero', path: ['basePriceEur'] },
  );

export function createListingsRouter(
  listingManager: ListingManager,
  listingSettingsRepo?: TenantListingSettingsRepository,
): Router {
  const router = Router();

  // Registered before '/:id' so 'settings' is not parsed as a listing id.
  router.get(
    '/settings',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!listingSettingsRepo) {
          res.status(501).json({
            error: {
              code: 'LISTING_SETTINGS_UNAVAILABLE',
              message: 'Listing settings are not configured on this deployment',
            },
          });
          return;
        }
        res.json({ settings: await listingSettingsRepo.get() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/settings',
    validate({ body: settingsUpdateSchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!listingSettingsRepo) {
          res.status(501).json({
            error: {
              code: 'LISTING_SETTINGS_UNAVAILABLE',
              message: 'Listing settings are not configured on this deployment',
            },
          });
          return;
        }
        const body = req.body as z.infer<typeof settingsUpdateSchema>;
        const update: TenantListingSettingsUpdate = {
          ...(body.pricePolicy !== undefined ? { pricePolicy: body.pricePolicy } : {}),
          ...(body.basePriceEur !== undefined ? { basePriceEur: body.basePriceEur } : {}),
          ...(body.offerAutoDeclineBelowEur !== undefined
            ? { offerAutoDeclineBelowEur: body.offerAutoDeclineBelowEur }
            : {}),
          ...(body.offerCounterEur !== undefined ? { offerCounterEur: body.offerCounterEur } : {}),
        };
        const settings = await listingSettingsRepo.set(update);
        res.json({ settings });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }
    try {
      const [listing, offers] = await Promise.all([
        listingManager.getListing(id),
        listingManager.getOffers(id),
      ]);
      if (!listing) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
        return;
      }
      res.json({ listing, offers });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filter: Record<string, string> = {};
      if (typeof req.query.status === 'string') filter.status = req.query.status;
      if (typeof req.query.marketplace === 'string') filter.marketplace = req.query.marketplace;
      if (typeof req.query.domain === 'string') filter.domain = req.query.domain;
      const listings = await listingManager.getListings(filter);
      res.json({ listings });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const { domain, marketplace, price } = req.body as {
      domain?: string;
      marketplace?: string;
      price?: number;
    };

    if (!domain || typeof domain !== 'string') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain is required' } });
      return;
    }

    if (marketplace && !['dan', 'afternic', 'sedo', 'godaddy', 'manual'].includes(marketplace)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid marketplace' } });
      return;
    }

    try {
      const listing = await listingManager.listDomain(
        domain,
        (marketplace ?? 'manual') as never,
        price,
      );
      res.status(201).json({ listing });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    const { price, status, notes } = req.body as {
      price?: number;
      status?: string;
      notes?: string;
    };

    // Defense in depth with ListingManager.updateListing: publish states are
    // reachable only via POST /:id/publish and the offer endpoints, which
    // enforce the trademark gate. A PATCH must never manufacture them.
    if (
      status !== undefined &&
      (status === 'listed' || status === 'sold' || status === 'offer_received')
    ) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `status '${status}' requires the publish/offer endpoints`,
        },
      });
      return;
    }

    const update: Record<string, unknown> = {};
    if (price !== undefined) update.priceEur = price;
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;

    try {
      const listing = await listingManager.updateListing(id, update as never);
      res.json({ listing });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }
    try {
      await listingManager.deleteListing(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }
    try {
      const listing = await listingManager.listOnMarketplace(id);
      res.json({ listing });
    } catch (err) {
      if ((err as { code?: string }).code === 'LISTING_MARKETPLACE_MISMATCH') {
        res.status(400).json({
          error: {
            code: 'LISTING_MARKETPLACE_MISMATCH',
            message: (err as Error).message,
          },
        });
        return;
      }
      next(err);
    }
  });

  router.post('/sync', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listingManager.syncAll();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/offers', async (req: Request, res: Response, next: NextFunction) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }
    try {
      const listing = await listingManager.getListing(id);
      if (!listing) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
        return;
      }
      const offers = await listingManager.getOffers(id);
      res.json({ offers });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/offers', async (req: Request, res: Response, next: NextFunction) => {
    const listingId = parseId(req.params.id);
    if (listingId === null) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    const { amount, buyer, notes } = req.body as {
      amount?: number;
      buyer?: string;
      notes?: string;
    };

    if (typeof amount !== 'number' || amount <= 0) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'Valid amount is required' } });
      return;
    }
    if (!buyer || typeof buyer !== 'string') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'buyer is required' } });
      return;
    }

    try {
      const offer = await listingManager.recordOffer(listingId, amount, buyer, notes);
      res.status(201).json({ offer });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:listingId/offers/:offerId/accept',
    async (req: Request, res: Response, next: NextFunction) => {
      const listingId = parseId(req.params.listingId);
      const offerId = parseId(req.params.offerId);
      if (listingId === null || offerId === null) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid ID' } });
        return;
      }
      try {
        await listingManager.respondToOffer(offerId, listingId, 'accepted');
        res.json({ status: 'accepted' });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:listingId/offers/:offerId/decline',
    async (req: Request, res: Response, next: NextFunction) => {
      const listingId = parseId(req.params.listingId);
      const offerId = parseId(req.params.offerId);
      if (listingId === null || offerId === null) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid ID' } });
        return;
      }
      try {
        await listingManager.respondToOffer(offerId, listingId, 'declined');
        res.json({ status: 'declined' });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
