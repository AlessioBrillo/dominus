import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoDaddyRegistrarProvider } from '../godaddy-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GoDaddyRegistrarProvider', () => {
  const validConfig = { apiKey: 'test-key', apiSecret: 'test-secret' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "godaddy"', () => {
    const provider = new GoDaddyRegistrarProvider(validConfig);
    expect(provider.name).toBe('godaddy');
  });

  it('checkPrice queries live API and returns availability', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        'example.com': { available: true, price: 11.99, currency: 'USD' },
        'taken.com': { available: false, price: 0, currency: 'USD' },
      }),
    );

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com', 'taken.com']);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.domain === 'example.com')?.available).toBe(true);
    expect(results.find((r) => r.domain === 'taken.com')?.available).toBe(false);
  });

  it('checkPrice falls back to static pricing on API error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API down'));

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com']);

    expect(results[0]?.available).toBe(true);
    expect(results[0]?.registerPriceEur).toBe(11.99);
  });

  it('purchase succeeds on API success', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ orderId: 'ord-123' }, 201));

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.priceEur).toBe(11.99);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/domains/purchase'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('purchase returns failure on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse([{ code: 'DOMAIN_EXISTS', message: 'Domain already registered' }], 422),
    );

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Domain already registered/);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns mapped domain info', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse([
        {
          domainId: '1',
          domain: 'alpha.com',
          status: 'ACTIVE',
          expires: '2027-06-08T00:00:00Z',
          renewAuto: true,
          locked: false,
          nameServers: ['ns1.godaddy.com'],
        },
        {
          domainId: '2',
          domain: 'beta.io',
          status: 'ACTIVE',
          expires: '2027-07-01T00:00:00Z',
          renewAuto: false,
          locked: true,
          nameServers: ['ns1.godaddy.com'],
        },
      ]),
    );

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const domains = await provider.listDomains();

    expect(domains).toHaveLength(2);
    expect(domains[0]?.domain).toBe('alpha.com');
    expect(domains[0]?.autoRenew).toBe(true);
    expect(domains[1]?.domain).toBe('beta.io');
    expect(domains[1]?.autoRenew).toBe(false);
  });

  it('listDomains returns empty on API error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API down'));

    const provider = new GoDaddyRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    const provider = new GoDaddyRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(11.99);
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    const provider = new GoDaddyRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.museum')).rejects.toThrow(
      /Unknown renewal pricing/,
    );
  });
});
