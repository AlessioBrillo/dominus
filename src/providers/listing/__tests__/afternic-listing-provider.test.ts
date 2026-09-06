// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AfternicListingProvider } from '../afternic-listing-provider.js';

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
  id: '67890',
  domain: 'example.com',
  buy_now_price: 2500,
  status: 'active' as const,
  listing_url: 'https://afternic.com/example',
  created_at: '2025-01-15T10:00:00Z',
  expires_at: '2026-01-15T10:00:00Z',
};

describe('AfternicListingProvider', () => {
  let provider: AfternicListingProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new AfternicListingProvider('test-api-key');
  });

  describe('isAvailable', () => {
    it('returns true when API key is set', () => {
      expect(provider.isAvailable).toBe(true);
    });

    it('returns false when API key is empty', () => {
      const p = new AfternicListingProvider(undefined);
      expect(p.isAvailable).toBe(false);
    });
  });

  describe('createListing', () => {
    it('creates a listing and returns mapped result', async () => {
      mockFetch.mockResolvedValue(mockResponse(testListing));

      const result = await provider.createListing({
        domain: 'example.com',
        marketplace: 'afternic',
        priceEur: 2500,
        listingUrl: null,
        status: 'draft',
        listedAt: null,
        expiresAt: null,
        notes: null,
      });

      expect(result.domain).toBe('example.com');
      expect(result.priceEur).toBe(2500);
      expect(result.marketplace).toBe('afternic');
      expect(result.id).toBe(67890);
      expect(result.listingUrl).toBe('https://afternic.com/example');
      expect(result.status).toBe('listed');
    });

    it('throws when API key is not configured', async () => {
      const p = new AfternicListingProvider(undefined);
      await expect(p.createListing({ domain: 'x.com' } as never)).rejects.toThrow(
        'Afternic API key is not configured',
      );
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue(mockError(400, 'Bad request'));
      await expect(
        provider.createListing({
          domain: 'example.com',
          marketplace: 'afternic',
          priceEur: 100,
          listingUrl: null,
          status: 'draft',
          listedAt: null,
          expiresAt: null,
          notes: null,
        }),
      ).rejects.toThrow('Afternic API error');
    });
  });

  describe('updateListing', () => {
    it('updates price and status', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ...testListing, buy_now_price: 3000, status: 'paused' }),
      );

      const result = await provider.updateListing('67890', {
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

      await expect(provider.cancelListing('67890')).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/listings/67890'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getListing', () => {
    it('returns undefined on 404', async () => {
      mockFetch.mockResolvedValue(mockError(404));
      await expect(provider.getListing('99999')).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('returns config error when unavailable', async () => {
      const p = new AfternicListingProvider(undefined);
      const result = await p.sync();
      expect(result.marketplace).toBe('afternic');
      expect(result.errors).toHaveLength(1);
    });

    it('paginates and collects offers', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ listings: [testListing], total: 2, page: 1 }))
        .mockResolvedValueOnce(
          mockResponse({
            listings: [{ ...testListing, id: '67891', domain: 'other.com' }],
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
  });
});
