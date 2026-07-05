import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DanListingProvider } from '../dan-listing-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockError(status: number, body?: string): Response {
  return new Response(body ?? 'Not Found', {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

const testListing = {
  id: '12345',
  domain: 'example.com',
  buy_now_price: 1500,
  status: 'active' as const,
  listing_url: 'https://dan.com/example',
  created_at: '2025-01-15T10:00:00Z',
  expires_at: '2026-01-15T10:00:00Z',
};

describe('DanListingProvider', () => {
  let provider: DanListingProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new DanListingProvider('test-api-key');
  });

  describe('isAvailable', () => {
    it('returns true when API key is set', () => {
      expect(provider.isAvailable).toBe(true);
    });

    it('returns false when API key is empty', () => {
      const p = new DanListingProvider(undefined);
      expect(p.isAvailable).toBe(false);
    });
  });

  describe('createListing', () => {
    it('creates a listing and returns mapped result', async () => {
      mockFetch.mockResolvedValue(mockResponse(testListing));

      const result = await provider.createListing({
        domain: 'example.com',
        marketplace: 'dan',
        priceEur: 1500,
        listingUrl: null,
        status: 'draft',
        listedAt: null,
        expiresAt: null,
        notes: null,
      });

      expect(result.domain).toBe('example.com');
      expect(result.priceEur).toBe(1500);
      expect(result.marketplace).toBe('dan');
      expect(result.id).toBe(12345);
      expect(result.listingUrl).toBe('https://dan.com/example');
      expect(result.status).toBe('listed');
    });

    it('throws when API key is not configured', async () => {
      const p = new DanListingProvider(undefined);
      await expect(p.createListing({ domain: 'x.com' } as never)).rejects.toThrow(
        'Dan.com API key is not configured',
      );
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue(mockError(400, 'Bad request'));
      await expect(
        provider.createListing({
          domain: 'example.com',
          marketplace: 'dan',
          priceEur: 100,
          listingUrl: null,
          status: 'draft',
          listedAt: null,
          expiresAt: null,
          notes: null,
        }),
      ).rejects.toThrow('Dan.com API error');
    });
  });

  describe('updateListing', () => {
    it('updates price and status', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ...testListing, buy_now_price: 2000, status: 'paused' }),
      );

      const result = await provider.updateListing('12345', {
        priceEur: 2000,
        status: 'paused',
      });

      expect(result.priceEur).toBe(2000);
      expect(result.status).toBe('paused');
    });
  });

  describe('cancelListing', () => {
    it('sends DELETE and succeeds', async () => {
      mockFetch.mockResolvedValue(mockResponse(null));

      await expect(provider.cancelListing('12345')).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/listings/12345'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getListing', () => {
    it('returns listing when found', async () => {
      mockFetch.mockResolvedValue(mockResponse(testListing));

      const result = await provider.getListing('12345');
      expect(result).toBeDefined();
      expect(result!.domain).toBe('example.com');
    });

    it('returns undefined on 404', async () => {
      mockFetch.mockResolvedValue(mockError(404));

      const result = await provider.getListing('99999');
      expect(result).toBeUndefined();
    });
  });

  describe('getListings', () => {
    it('returns mapped listings', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          listings: [
            testListing,
            { ...testListing, id: '67890', domain: 'test.io', buy_now_price: 500 },
          ],
          total: 2,
          page: 1,
        }),
      );

      const results = await provider.getListings();
      expect(results).toHaveLength(2);
      expect(results[0]!.domain).toBe('example.com');
      expect(results[1]!.domain).toBe('test.io');
      expect(results[1]!.priceEur).toBe(500);
    });
  });

  describe('getOffers', () => {
    it('returns mapped offers', async () => {
      mockFetch.mockResolvedValue(
        mockResponse([
          {
            id: '1',
            amount: 1200,
            buyer: 'buyer1',
            status: 'pending',
            created_at: '2025-02-01T00:00:00Z',
          },
          {
            id: '2',
            amount: 1300,
            buyer: 'buyer2',
            status: 'accepted',
            created_at: '2025-02-02T00:00:00Z',
          },
        ]),
      );

      const offers = await provider.getOffers('12345');
      expect(offers).toHaveLength(2);
      expect(offers[0]!.amountEur).toBe(1200);
      expect(offers[0]!.buyer).toBe('buyer1');
      expect(offers[0]!.status).toBe('pending');
      expect(offers[1]!.status).toBe('accepted');
    });
  });

  describe('sync', () => {
    it('returns error when not configured', async () => {
      const p = new DanListingProvider(undefined);
      const result = await p.sync();
      expect(result.errors).toContain('Dan.com API key not configured');
      expect(result.listings).toHaveLength(0);
    });

    it('paginates through multiple pages', async () => {
      const page1 = Array.from({ length: 25 }, (_, i) => ({
        ...testListing,
        id: `${i + 1}`,
        domain: `page1-${i}.com`,
      }));
      const page2 = Array.from({ length: 5 }, (_, i) => ({
        ...testListing,
        id: `${i + 26}`,
        domain: `page2-${i}.io`,
      }));

      mockFetch
        .mockResolvedValueOnce(mockResponse({ listings: page1, total: 30, page: 1 }))
        .mockResolvedValueOnce(mockResponse({ listings: page2, total: 30, page: 2 }));

      const page1Offers = page1.map(() => mockResponse([]));
      const page2Offers = page2.map(() => mockResponse([]));
      for (const r of [...page1Offers, ...page2Offers]) {
        mockFetch.mockResolvedValueOnce(r);
      }

      const result = await provider.sync();
      expect(result.listings).toHaveLength(30);
      expect(result.errors).toHaveLength(0);
    });

    it('fetches all listings and their offers', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({
            listings: [testListing, { ...testListing, id: '999', domain: 'alpha.io' }],
            total: 2,
            page: 1,
          }),
        )
        .mockResolvedValueOnce(
          mockResponse([
            {
              id: '10',
              amount: 1000,
              buyer: 'bob',
              status: 'pending',
              created_at: '2025-03-01T00:00:00Z',
            },
          ]),
        )
        .mockResolvedValueOnce(mockResponse([]));

      const result = await provider.sync();
      expect(result.listings).toHaveLength(2);
      expect(result.offers).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.marketplace).toBe('dan');
    });

    it('collects per-listing errors', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({
            listings: [testListing, { ...testListing, id: '999', domain: 'broken.io' }],
            total: 2,
            page: 1,
          }),
        )
        .mockResolvedValueOnce(mockResponse([]))
        .mockRejectedValueOnce(new Error('Network failure'));

      const result = await provider.sync();
      expect(result.listings).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('broken.io');
    });
  });
});
