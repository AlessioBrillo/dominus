import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PorkbunRegistrarProvider } from '../porkbun-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PorkbunRegistrarProvider', () => {
  const validConfig = { apiKey: 'test-key', secretApiKey: 'test-secret' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "porkbun"', () => {
    const provider = new PorkbunRegistrarProvider(validConfig);
    expect(provider.name).toBe('porkbun');
  });

  it('checkPrice uses static pricing for known TLDs', async () => {
    const provider = new PorkbunRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com', 'test.io']);
    expect(results).toHaveLength(2);
    expect(results[0]?.available).toBe(true);
    expect(results[0]?.registerPriceEur).toBe(8.77);
    expect(results[1]?.registerPriceEur).toBe(28.99);
  });

  it('checkPrice returns null pricing for unknown TLDs', async () => {
    const provider = new PorkbunRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.museum']);
    expect(results[0]?.registerPriceEur).toBeNull();
  });

  it('purchase succeeds on API success', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        status: 'SUCCESS',
        response: {
          domain: 'example.com',
          orderId: 'ord-123',
          price: 8.77,
        },
      }),
    );

    const provider = new PorkbunRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.priceEur).toBe(8.77);
  });

  it('purchase returns failure on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ status: 'ERROR', error: 'Domain already registered' }),
    );

    const provider = new PorkbunRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Domain already registered/);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new PorkbunRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns mapped domain info', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        status: 'SUCCESS',
        response: {
          domains: [
            { domain: 'alpha.com', expiry: '2027-06-08', auto_renew: '1' },
            { domain: 'beta.io', expiry: '2027-07-01', auto_renew: '0' },
          ],
        },
      }),
    );

    const provider = new PorkbunRegistrarProvider(validConfig);
    const domains = await provider.listDomains();

    expect(domains).toHaveLength(2);
    expect(domains[0]?.domain).toBe('alpha.com');
    expect(domains[0]?.autoRenew).toBe(true);
    expect(domains[1]?.domain).toBe('beta.io');
    expect(domains[1]?.autoRenew).toBe(false);
  });

  it('listDomains returns empty on no domains', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ status: 'SUCCESS', response: [] }));

    const provider = new PorkbunRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    const provider = new PorkbunRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(8.77);
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    const provider = new PorkbunRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.museum')).rejects.toThrow(
      /Unknown renewal pricing/,
    );
  });
});
