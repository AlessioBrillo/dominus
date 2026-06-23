import { Router, type Request, type Response } from 'express';
import type { ListingManager } from '../../listing/listing-manager.js';

export function createListingsRouter(listingManager: ListingManager): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const filter: Record<string, string> = {};
    if (typeof req.query.status === 'string') filter.status = req.query.status;
    if (typeof req.query.marketplace === 'string') filter.marketplace = req.query.marketplace;
    if (typeof req.query.domain === 'string') filter.domain = req.query.domain;

    const listings = listingManager.getListings(filter);
    res.json({ listings });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    const listing = listingManager.getListing(id);
    if (!listing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
      return;
    }

    const offers = listingManager.getOffers(id);
    res.json({ listing, offers });
  });

  router.post('/', async (req: Request, res: Response) => {
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
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'LISTING_FAILED', message } });
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    const { price, status, notes } = req.body as {
      price?: number;
      status?: string;
      notes?: string;
    };

    const update: Record<string, unknown> = {};
    if (price !== undefined) update.priceEur = price;
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;

    try {
      const listing = await listingManager.updateListing(id, update as never);
      res.json({ listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'UPDATE_FAILED', message } });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    try {
      await listingManager.deleteListing(id);
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'DELETE_FAILED', message } });
    }
  });

  router.post('/:id/publish', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    try {
      const listing = await listingManager.listOnMarketplace(id);
      res.json({ listing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'PUBLISH_FAILED', message } });
    }
  });

  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      const result = await listingManager.syncAll();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'SYNC_FAILED', message } });
    }
  });

  router.get('/:id/offers', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid listing ID' } });
      return;
    }

    const listing = listingManager.getListing(id);
    if (!listing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
      return;
    }

    const offers = listingManager.getOffers(id);
    res.json({ offers });
  });

  router.post('/:id/offers', async (req: Request, res: Response) => {
    const listingId = parseInt(req.params.id as string, 10);
    if (isNaN(listingId)) {
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
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'OFFER_FAILED', message } });
    }
  });

  router.post('/:listingId/offers/:offerId/accept', async (req: Request, res: Response) => {
    const listingId = parseInt(req.params.listingId as string, 10);
    const offerId = parseInt(req.params.offerId as string, 10);
    if (isNaN(listingId) || isNaN(offerId)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid ID' } });
      return;
    }

    try {
      await listingManager.respondToOffer(offerId, listingId, 'accepted');
      res.json({ status: 'accepted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'ACCEPT_FAILED', message } });
    }
  });

  router.post('/:listingId/offers/:offerId/decline', async (req: Request, res: Response) => {
    const listingId = parseInt(req.params.listingId as string, 10);
    const offerId = parseInt(req.params.offerId as string, 10);
    if (isNaN(listingId) || isNaN(offerId)) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid ID' } });
      return;
    }

    try {
      await listingManager.respondToOffer(offerId, listingId, 'declined');
      res.json({ status: 'declined' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'DECLINE_FAILED', message } });
    }
  });

  return router;
}
