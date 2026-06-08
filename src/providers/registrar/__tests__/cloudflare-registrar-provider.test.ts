import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareRegistrarProvider } from '../cloudflare-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeCfResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflareRegistrarProvider', () => {
  const validConfig = { apiToken: 'test-token', accountId: 'test-account' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "cloudflare"', () => {
    const provider = new CloudflareRegistrarProvider(validConfig);
    expect(provider.name).toBe('cloudflare');
  });

  it('throws on checkPrice when credentials are missing', async () => {
    const provider = new CloudflareRegistrarProvider({ apiToken: undefined, accountId: undefined });
    await expect(provider.checkPrice(['example.com'])).rejects.toThrow(
      /Cloudflare API credentials not configured/,
    );
  });

  it('throws on purchase when credentials are missing', async () => {
    const provider = new CloudflareRegistrarProvider({ apiToken: undefined, accountId: undefined });
    const result = await provider.purchase({ domain: 'example.com', years: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cloudflare API credentials not configured/);
  });

  it('checkPrice marks managed domains as unavailable', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({
        success: true,
        errors: [],
        result: [
          {
            id: '1',
            domain: 'managed.com',
            expires_at: '2027-06-08T00:00:00Z',
            auto_renew: true,
            locked: false,
            name_servers: ['ns1.cloudflare.com'],
          },
        ],
      }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['managed.com', 'new.io']);

    expect(results).toHaveLength(2);

    const managed = results.find((r) => r.domain === 'managed.com');
    expect(managed?.available).toBe(false);
    expect(managed?.registerPriceEur).toBeNull();
    expect(managed?.renewalPriceEur).toBe(8.50);

    const available = results.find((r) => r.domain === 'new.io');
    expect(available?.available).toBe(true);
    expect(available?.registerPriceEur).toBe(30.20);
  });

  it('checkPrice returns null pricing for unknown TLDs', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({ success: true, errors: [], result: [] }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.xyz']);

    expect(results[0]?.registerPriceEur).toBeNull();
    expect(results[0]?.renewalPriceEur).toBeNull();
  });

  it('checkPrice handles empty domain list', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({ success: true, errors: [], result: [] }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const results = await provider.checkPrice([]);
    expect(results).toHaveLength(0);
  });

  it('purchase succeeds for available domain', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({
        success: true,
        errors: [],
        result: {
          id: 'order-1',
          domain: 'example.com',
          expires_at: '2027-06-08T00:00:00Z',
        },
      }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.activeAt).toBe('2027-06-08T00:00:00Z');
    expect(result.message).toMatch(/Cloudflare Registrar/);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/registrar/domains/example.com/register'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"years":1'),
      }),
    );
  });

  it('purchase returns failure on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse(
        { success: false, errors: [{ code: 1000, message: 'Domain not available' }] },
        400,
      ),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Domain not available/);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new CloudflareRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns mapped domain info', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({
        success: true,
        errors: [],
        result: [
          {
            id: '1',
            domain: 'alpha.com',
            expires_at: '2027-06-08T00:00:00Z',
            auto_renew: true,
            locked: false,
            name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
          },
          {
            id: '2',
            domain: 'beta.io',
            expires_at: '2027-07-01T00:00:00Z',
            auto_renew: false,
            locked: true,
            name_servers: ['ns1.cloudflare.com'],
          },
        ],
      }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const domains = await provider.listDomains();

    expect(domains).toHaveLength(2);

    expect(domains[0]).toEqual({
      domain: 'alpha.com',
      registrar: 'cloudflare',
      expiryDate: '2027-06-08T00:00:00Z',
      autoRenew: true,
      locked: false,
      nameServers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    });

    expect(domains[1]).toEqual({
      domain: 'beta.io',
      registrar: 'cloudflare',
      expiryDate: '2027-07-01T00:00:00Z',
      autoRenew: false,
      locked: true,
      nameServers: ['ns1.cloudflare.com'],
    });
  });

  it('listDomains returns empty array on API success with no domains', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({ success: true, errors: [], result: [] }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('listDomains throws on API error', async () => {
    mockFetch.mockResolvedValueOnce(makeCfResponse({ success: false, errors: [{ code: 6003, message: 'Auth error' }] }));

    const provider = new CloudflareRegistrarProvider(validConfig);
    await expect(provider.listDomains()).rejects.toThrow(/Cloudflare API/);
  });

  it('listDomains throws on credentials missing', async () => {
    const provider = new CloudflareRegistrarProvider({ apiToken: undefined, accountId: undefined });
    await expect(provider.listDomains()).rejects.toThrow(/Cloudflare API credentials not configured/);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({
        success: true,
        errors: [],
        result: {
          id: '1',
          domain: 'example.com',
          expires_at: '2027-06-08T00:00:00Z',
          auto_renew: true,
          locked: false,
          name_servers: ['ns1.cloudflare.com'],
        },
      }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(8.50);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/registrar/domains/example.com'),
      expect.any(Object),
    );
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    mockFetch.mockResolvedValueOnce(
      makeCfResponse({
        success: true,
        errors: [],
        result: {
          id: '1',
          domain: 'example.xyz',
          expires_at: '2027-06-08T00:00:00Z',
          auto_renew: true,
          locked: false,
          name_servers: ['ns1.cloudflare.com'],
        },
      }),
    );

    const provider = new CloudflareRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.xyz')).rejects.toThrow(/Unknown renewal pricing/);
  });

  it('getRenewalCost throws on API error', async () => {
    mockFetch.mockResolvedValueOnce(makeCfResponse({ success: false, errors: [{ code: 6003, message: 'Not found' }] }, 404));

    const provider = new CloudflareRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('missing.com')).rejects.toThrow();
  });

  it('getRenewalCost throws on credentials missing', async () => {
    const provider = new CloudflareRegistrarProvider({ apiToken: undefined, accountId: undefined });
    await expect(provider.getRenewalCost('example.com')).rejects.toThrow(
      /Cloudflare API credentials not configured/,
    );
  });
});
