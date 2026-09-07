// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SedoListingProvider } from '../sedo-listing-provider.js';
import { createListingProvider } from '../index.js';
import { safeRemoteNumericId, MAX_SYNC_PAGES } from '../remote-id.js';

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
  id: 'sd-1001',
  domain: 'example.com',
  buy_now_price: 2500,
  status: 'active' as const,
  listing_url: 'https://sedo.com/example',
  created_at: '2025-01-15T10:00:00Z',
  expires_at: '2026-01-15T10:00:00Z',
};

describe('SedoListingProvider', () => {
  let provider: SedoListingProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new SedoListingProvider('test-api-key');
  });

  describe('isAvailable', () => {
    it('returns true when API key is set', () => {
      expect(provider.isAvailable).toBe(true);
    });

    it('returns false when API key is missing', () => {
      expect(new SedoListingProvider(undefined).isAvailable).toBe(false);
    });
  });

  describe('createListing', () => {
    it('creates a listing and maps a string remote id without NaN', async () => {
      mockFetch.mockResolvedValue(mockResponse(testListing));

      const result = await provider.createListing({
        domain: 'example.com',
        marketplace: 'sedo',
        priceEur: 2500,
        listingUrl: null,
        status: 'draft',
        listedAt: null,
        expiresAt: null,
        notes: null,
      });

      expect(result.domain).toBe('example.com');
      expect(result.priceEur).toBe(2500);
      expect(result.marketplace).toBe('sedo');
      expect(result.externalId).toBe('sd-1001');
      expect(Number.isFinite(result.id)).toBe(true);
      expect(result.listingUrl).toBe('https://sedo.com/example');
      expect(result.status).toBe('listed');
    });

    it('throws when API key is not configured', async () => {
      const p = new SedoListingProvider(undefined);
      await expect(p.createListing({ domain: 'x.com' } as never)).rejects.toThrow(
        'Sedo API key is not configured',
      );
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue(mockError(400, 'Bad request'));
      await expect(
        provider.createListing({
          domain: 'example.com',
          marketplace: 'sedo',
          priceEur: 100,
          listingUrl: null,
          status: 'draft',
          listedAt: null,
          expiresAt: null,
          notes: null,
        }),
      ).rejects.toThrow('Sedo API error');
    });

    it('sends Bearer auth', async () => {
      mockFetch.mockResolvedValue(mockResponse(testListing));
      await provider.createListing({
        domain: 'example.com',
        marketplace: 'sedo',
        priceEur: 100,
        listingUrl: null,
        status: 'draft',
        listedAt: null,
        expiresAt: null,
        notes: null,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/listings'),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }),
        }),
      );
    });
  });

  describe('updateListing', () => {
    it('updates price and status', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ...testListing, buy_now_price: 3000, status: 'paused' }),
      );

      const result = await provider.updateListing('sd-1001', {
        priceEur: 3000,
        status: 'paused',
      });

      expect(result.priceEur).toBe(3000);
      expect(result.status).toBe('paused');
    });
  });

  describe('cancelListing', () => {
    it('sends DELETE and succeeds', async () => {
      mockFetch.mockResolvedValue(mockResponse(null));

      await expect(provider.cancelListing('sd-1001')).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/listings/sd-1001'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getListing', () => {
    it('returns undefined on 404', async () => {
      mockFetch.mockResolvedValue(mockError(404));
      await expect(provider.getListing('sd-9999')).resolves.toBeUndefined();
    });
  });

  describe('getOffers', () => {
    it('links string-id offers to a finite numeric listing id', async () => {
      mockFetch.mockResolvedValue(
        mockResponse([
          {
            id: 'of-1',
            amount: 900,
            buyer: 'b@example.com',
            status: 'pending',
            created_at: '2025-02-01T00:00:00Z',
          },
        ]),
      );
      const offers = await provider.getOffers('sd-1001');
      expect(offers).toHaveLength(1);
      expect(Number.isFinite(offers[0]!.listingId)).toBe(true);
      expect(Number.isFinite(offers[0]!.id)).toBe(true);
    });
  });

  describe('sync', () => {
    it('returns config error when unavailable', async () => {
      const result = await new SedoListingProvider(undefined).sync();
      expect(result.marketplace).toBe('sedo');
      expect(result.errors).toHaveLength(1);
    });

    it('paginates and collects offers', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ listings: [testListing], total: 2, page: 1 }))
        .mockResolvedValueOnce(
          mockResponse({
            listings: [{ ...testListing, id: 'sd-1002', domain: 'other.com' }],
            total: 2,
            page: 2,
          }),
        )
        .mockResolvedValueOnce(mockResponse([]))
        .mockResolvedValueOnce(mockResponse([]));

      const result = await provider.sync();
      expect(result.listings).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it('stops paginating when the reported total keeps growing', async () => {
      mockFetch.mockImplementation((url: unknown) =>
        Promise.resolve(
          mockResponse({
            listings: [testListing],
            total: Number.MAX_SAFE_INTEGER,
            page: 1,
            url: String(url),
          }),
        ),
      );

      const result = await provider.sync();
      expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(
        MAX_SYNC_PAGES + result.listings.length,
      );
      expect(result.errors.join(' ')).toContain('pagination truncated');
    });
  });

  describe('factory wiring', () => {
    it('creates a sedo provider via createListingProvider', () => {
      const p = createListingProvider('sedo', {
        listingRepo: {} as never,
        danApiKey: undefined,
        sedoApiKey: 'k',
      });
      expect(p.name).toBe('sedo');
    });
  });
});

describe('safeRemoteNumericId', () => {
  it('keeps numeric ids stable', () => {
    expect(safeRemoteNumericId('67890')).toBe(67890);
  });

  it('never returns NaN for string ids and groups equal ids equally', () => {
    const a = safeRemoteNumericId('sd-1001');
    expect(Number.isFinite(a)).toBe(true);
    expect(safeRemoteNumericId('sd-1001')).toBe(a);
  });
});
