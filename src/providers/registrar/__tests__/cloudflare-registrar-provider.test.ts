import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareRegistrarProvider } from '../cloudflare-registrar-provider.js';
import { ProviderError } from '../../../types/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockCfResponse<T>(result: T, success = true): Response {
  return new Response(JSON.stringify({ success, errors: [], messages: [], result }), {
    status: success ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockCfError(status: number, body?: string): Response {
  return new Response(
    body ??
      JSON.stringify({
        success: false,
        errors: [{ code: 9999, message: 'API error' }],
        messages: [],
        result: null,
      }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('CloudflareRegistrarProvider', () => {
  let provider: CloudflareRegistrarProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new CloudflareRegistrarProvider('test-token', 'test-account');
  });

  describe('registration descriptor', () => {
    it('has the correct name', () => {
      expect(CloudflareRegistrarProvider.registration.name).toBe('cloudflare');
    });

    it('requires apiToken and accountId config fields', () => {
      const fields = CloudflareRegistrarProvider.registration.descriptor.configFields;
      const apiTokenField = fields.find((f) => f.key === 'apiToken');
      const accountIdField = fields.find((f) => f.key === 'accountId');
      expect(apiTokenField).toBeDefined();
      expect(apiTokenField!.required).toBe(true);
      expect(accountIdField).toBeDefined();
      expect(accountIdField!.required).toBe(true);
    });

    it('factory throws when apiToken is missing', () => {
      expect(() =>
        CloudflareRegistrarProvider.registration.create({ accountId: 'acc-123' }),
      ).toThrow(ProviderError);
    });

    it('factory throws when accountId is missing', () => {
      expect(() =>
        CloudflareRegistrarProvider.registration.create({ apiToken: 'tok-123' }),
      ).toThrow(ProviderError);
    });

    it('factory creates instance with valid config', () => {
      const instance = CloudflareRegistrarProvider.registration.create({
        apiToken: 'tok-123',
        accountId: 'acc-123',
      });
      expect(instance).toBeInstanceOf(CloudflareRegistrarProvider);
      expect(instance.name).toBe('cloudflare');
    });
  });

  describe('checkPrice', () => {
    it('returns pricing for a managed domain', async () => {
      mockFetch.mockResolvedValue(
        mockCfResponse({
          id: 'domain-id',
          domain: 'example.com',
          available: true,
          supported_tld: true,
          register_price: 9.77,
          renew_price: 9.77,
          transfer_in: null,
        }),
      );

      const results = await provider.checkPrice(['example.com']);
      expect(results).toHaveLength(1);
      expect(results[0]!.domain).toBe('example.com');
      expect(results[0]!.available).toBe(true);
      expect(results[0]!.registerPriceEur).toBe(9.77);
      expect(results[0]!.renewalPriceEur).toBe(9.77);
    });

    it('returns null pricing for an unknown domain (no API match)', async () => {
      mockFetch.mockResolvedValue(mockCfError(404));

      const results = await provider.checkPrice(['unknown-domain.xyz']);
      expect(results).toHaveLength(1);
      expect(results[0]!.domain).toBe('unknown-domain.xyz');
      expect(results[0]!.available).toBe(true);
      expect(results[0]!.registerPriceEur).toBeNull();
      expect(results[0]!.renewalPriceEur).toBeNull();
    });

    it('handles network error gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNRESET'));

      const results = await provider.checkPrice(['example.com']);
      expect(results).toHaveLength(1);
      expect(results[0]!.available).toBe(true);
      expect(results[0]!.registerPriceEur).toBeNull();
    });

    it('handles multiple domains', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'id-1',
            domain: 'alpha.com',
            available: true,
            supported_tld: true,
            register_price: 9.77,
            renew_price: 9.77,
            transfer_in: null,
          }),
        )
        .mockResolvedValueOnce(mockCfError(404));

      const results = await provider.checkPrice(['alpha.com', 'beta.io']);
      expect(results).toHaveLength(2);
      expect(results[0]!.registerPriceEur).toBe(9.77);
      expect(results[1]!.registerPriceEur).toBeNull();
    });
  });

  describe('purchase', () => {
    it('registers a domain successfully and uses expectedPriceEur', async () => {
      // pre-purchase price fetch returns null price → falls back to expectedPriceEur
      mockFetch
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'price-check',
            domain: 'example.com',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 9.77,
            transfer_in: null,
          }),
        )
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'order-123',
            domain: 'example.com',
            expires_at: '2027-06-26T00:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'info-1',
            domain: 'example.com',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 9.77,
            transfer_in: null,
          }),
        );

      const result = await provider.purchase({
        domain: 'example.com',
        years: 1,
        expectedPriceEur: 9.77,
      });
      expect(result.success).toBe(true);
      expect(result.orderId).toBe('order-123');
      expect(result.priceEur).toBe(9.77);
      expect(result.activeAt).toBe('2027-06-26T00:00:00Z');
    });

    it('registers and multiplies expectedPriceEur by years', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'price-check',
            domain: 'example.com',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 9.77,
            transfer_in: null,
          }),
        )
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'order-456',
            domain: 'example.com',
            expires_at: '2029-06-26T00:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          mockCfResponse({
            id: 'info-2',
            domain: 'example.com',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 9.77,
            transfer_in: null,
          }),
        );

      const result = await provider.purchase({
        domain: 'example.com',
        years: 3,
        expectedPriceEur: 9.77,
      });
      expect(result.success).toBe(true);
      expect(result.priceEur).toBe(29.31);
    });

    it('returns failure on HTTP error', async () => {
      // pre-purchase fetch fails on HTTP 403 → falls through gracefully
      mockFetch
        .mockResolvedValueOnce(mockCfError(403, 'Insufficient permissions'))
        .mockResolvedValueOnce(mockCfError(403, 'Insufficient permissions'));

      const result = await provider.purchase({ domain: 'example.com', years: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns failure on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.purchase({ domain: 'example.com', years: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('returns failure when API returns success=false', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: 'Domain not available for registration' }],
              messages: [],
              result: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: 'Domain not available for registration' }],
              messages: [],
              result: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

      const result = await provider.purchase({ domain: 'example.com', years: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Domain not available');
    });
  });

  describe('listDomains', () => {
    it('returns parsed domain list from API', async () => {
      mockFetch.mockResolvedValue(
        mockCfResponse([
          {
            id: 'd1',
            domain: 'alpha.com',
            expires_at: '2027-06-26T00:00:00Z',
            auto_renew: true,
            locked: false,
            privacy: true,
            created_at: '2024-01-01T00:00:00Z',
            transfer_in: null,
            current_registrar: 'Cloudflare',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 9.77,
          },
          {
            id: 'd2',
            domain: 'beta.io',
            expires_at: '2027-12-31T00:00:00Z',
            auto_renew: false,
            locked: true,
            privacy: true,
            created_at: '2025-03-15T00:00:00Z',
            transfer_in: null,
            current_registrar: 'Cloudflare',
            available: false,
            supported_tld: true,
            register_price: null,
            renew_price: 14.99,
          },
        ]),
      );

      const domains = await provider.listDomains();
      expect(domains).toHaveLength(2);
      expect(domains[0]!.domain).toBe('alpha.com');
      expect(domains[0]!.autoRenew).toBe(true);
      expect(domains[0]!.expiryDate).toBe('2027-06-26T00:00:00Z');
      expect(domains[1]!.domain).toBe('beta.io');
      expect(domains[1]!.locked).toBe(true);
    });

    it('returns empty array on API error', async () => {
      mockFetch.mockResolvedValue(mockCfError(500));

      const domains = await provider.listDomains();
      expect(domains).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ENOTFOUND'));

      const domains = await provider.listDomains();
      expect(domains).toEqual([]);
    });
  });

  describe('getRenewalCost', () => {
    it('returns renewal price from API', async () => {
      mockFetch.mockResolvedValue(
        mockCfResponse({
          id: 'info-1',
          domain: 'example.com',
          available: false,
          supported_tld: true,
          register_price: null,
          renew_price: 9.77,
          transfer_in: null,
        }),
      );

      const cost = await provider.getRenewalCost('example.com');
      expect(cost).toBe(9.77);
    });

    it('returns 0 when API returns no renew_price', async () => {
      mockFetch.mockResolvedValue(
        mockCfResponse({
          id: 'info-1',
          domain: 'example.com',
          available: false,
          supported_tld: true,
          register_price: null,
          renew_price: null,
          transfer_in: null,
        }),
      );

      const cost = await provider.getRenewalCost('example.com');
      expect(cost).toBe(0);
    });

    it('returns 0 on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

      const cost = await provider.getRenewalCost('example.com');
      expect(cost).toBe(0);
    });
  });
});
