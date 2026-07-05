import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createListingsRouter } from '../listings.js';
import { errorHandler } from '../../middleware/error-handler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockListingManager(): any {
  return {
    getListing: vi.fn(),
    getListings: vi.fn(),
    listDomain: vi.fn(),
    updateListing: vi.fn(),
    deleteListing: vi.fn(),
    listOnMarketplace: vi.fn(),
    syncAll: vi.fn(),
    getOffers: vi.fn(),
    recordOffer: vi.fn(),
    respondToOffer: vi.fn(),
  };
}

function makeListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    domain: 'example.com',
    marketplace: 'manual',
    listingUrl: null,
    priceEur: 1500,
    status: 'draft',
    scoringSnapshotJson: null,
    listedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Listings API', () => {
  describe('GET /listings', () => {
    it('returns an empty array', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ listings: [] });
    });

    it('returns listings and passes query filters', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([makeListing()]);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings?status=listed&marketplace=dan');
      expect(res.status).toBe(200);
      expect(res.body.listings).toHaveLength(1);
      expect(mgr.getListings).toHaveBeenCalledWith({ status: 'listed', marketplace: 'dan' });
    });
  });

  describe('GET /listings/:id', () => {
    it('returns listing and offers', async () => {
      const mgr = createMockListingManager();
      mgr.getListing.mockResolvedValue(makeListing());
      mgr.getOffers.mockResolvedValue([]);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings/1');
      expect(res.status).toBe(200);
      expect(res.body.listing.domain).toBe('example.com');
      expect(res.body.offers).toEqual([]);
    });

    it('returns 404 for unknown listing', async () => {
      const mgr = createMockListingManager();
      mgr.getListing.mockResolvedValue(undefined);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings/999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id', async () => {
      const mgr = createMockListingManager();
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /listings', () => {
    it('creates a listing', async () => {
      const mgr = createMockListingManager();
      mgr.listDomain.mockResolvedValue(makeListing({ id: 42 }));
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings').send({ domain: 'test.io', price: 2000 });
      expect(res.status).toBe(201);
      expect(res.body.listing.id).toBe(42);
    });

    it('returns 400 without domain', async () => {
      const mgr = createMockListingManager();
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings').send({ price: 2000 });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /listings/:id', () => {
    it('updates a listing', async () => {
      const mgr = createMockListingManager();
      mgr.updateListing.mockResolvedValue(makeListing({ priceEur: 2500, status: 'listed' }));
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).patch('/listings/1').send({ price: 2500, status: 'listed' });
      expect(res.status).toBe(200);
      expect(res.body.listing.priceEur).toBe(2500);
    });

    it('returns 400 for invalid id', async () => {
      const mgr = createMockListingManager();
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).patch('/listings/abc').send({ price: 100 });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /listings/:id', () => {
    it('deletes a listing', async () => {
      const mgr = createMockListingManager();
      mgr.deleteListing.mockResolvedValue(undefined);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).delete('/listings/1');
      expect(res.status).toBe(204);
    });
  });

  describe('POST /listings/:id/publish', () => {
    it('publishes a listing', async () => {
      const mgr = createMockListingManager();
      mgr.listOnMarketplace.mockResolvedValue(makeListing({ status: 'listed' }));
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings/1/publish');
      expect(res.status).toBe(200);
      expect(res.body.listing.status).toBe('listed');
    });
  });

  describe('POST /listings/sync', () => {
    it('syncs all listings', async () => {
      const mgr = createMockListingManager();
      mgr.syncAll.mockResolvedValue({
        marketplace: 'dan',
        listings: [makeListing()],
        offers: [],
        errors: [],
        syncedAt: new Date().toISOString(),
      });
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings/sync');
      expect(res.status).toBe(200);
      expect(res.body.listings).toHaveLength(1);
    });
  });

  describe('GET /listings/:id/offers', () => {
    it('returns offers for a listing', async () => {
      const mgr = createMockListingManager();
      mgr.getListing.mockResolvedValue(makeListing());
      mgr.getOffers.mockResolvedValue([
        {
          id: 1,
          listingId: 1,
          amountEur: 1000,
          buyer: 'buyer1',
          status: 'pending',
          receivedAt: '2025-02-01T00:00:00Z',
          respondedAt: null,
          notes: null,
        },
      ]);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings/1/offers');
      expect(res.status).toBe(200);
      expect(res.body.offers).toHaveLength(1);
      expect(res.body.offers[0].amountEur).toBe(1000);
    });

    it('returns 404 when listing not found', async () => {
      const mgr = createMockListingManager();
      mgr.getListing.mockResolvedValue(undefined);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).get('/listings/999/offers');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /listings/:id/offers', () => {
    it('records an offer', async () => {
      const mgr = createMockListingManager();
      mgr.recordOffer.mockResolvedValue({
        id: 1,
        listingId: 1,
        amountEur: 1200,
        buyer: 'buyer1',
        status: 'pending',
        receivedAt: '2025-03-01T00:00:00Z',
        respondedAt: null,
        notes: null,
      });
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app)
        .post('/listings/1/offers')
        .send({ amount: 1200, buyer: 'buyer1' });
      expect(res.status).toBe(201);
      expect(res.body.offer.amountEur).toBe(1200);
    });

    it('returns 400 without amount', async () => {
      const mgr = createMockListingManager();
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings/1/offers').send({ buyer: 'buyer1' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /listings/:id/offers/:offerId/accept', () => {
    it('accepts an offer', async () => {
      const mgr = createMockListingManager();
      mgr.respondToOffer.mockResolvedValue(undefined);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings/1/offers/1/accept');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');
    });
  });

  describe('POST /listings/:id/offers/:offerId/decline', () => {
    it('declines an offer', async () => {
      const mgr = createMockListingManager();
      mgr.respondToOffer.mockResolvedValue(undefined);
      const app = express();
      app.use(express.json());
      app.use('/listings', createListingsRouter(mgr));
      app.use(errorHandler);

      const res = await request(app).post('/listings/1/offers/1/decline');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('declined');
    });
  });
});
