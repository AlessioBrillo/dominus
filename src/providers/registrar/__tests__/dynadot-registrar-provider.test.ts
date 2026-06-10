import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynadotRegistrarProvider } from '../dynadot-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DynadotRegistrarProvider', () => {
  const validConfig = { apiKey: 'test-key' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "dynadot"', () => {
    const provider = new DynadotRegistrarProvider(validConfig);
    expect(provider.name).toBe('dynadot');
  });

  it('checkPrice uses static pricing for known TLDs', async () => {
    const provider = new DynadotRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com', 'test.io']);
    expect(results).toHaveLength(2);
    expect(results[0]?.available).toBe(true);
    expect(results[0]?.registerPriceEur).toBe(8.99);
    expect(results[1]?.registerPriceEur).toBe(32.99);
  });

  it('checkPrice returns null pricing for unknown TLDs', async () => {
    const provider = new DynadotRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.museum']);
    expect(results[0]?.registerPriceEur).toBeNull();
  });

  it('purchase succeeds on API success', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        DynadotApiResponse: {
          Head: { ResultCode: '1', Status: 'success' },
          Body: { Content: { OrderId: 'ord-123' } },
        },
      }),
    );

    const provider = new DynadotRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.priceEur).toBe(8.99);
  });

  it('purchase returns failure on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        DynadotApiResponse: {
          Head: { ResultCode: '0', Status: 'error' },
          Body: { Content: 'Domain not available' },
        },
      }),
    );

    const provider = new DynadotRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new DynadotRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns mapped domain info', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        DynadotApiResponse: {
          Head: { ResultCode: '1', Status: 'success' },
          Body: {
            DomainList: [
              {
                Domain: 'alpha.com',
                ExpirationDate: '2027-06-08',
                AutoRenew: 'Y',
              },
              {
                Domain: 'beta.io',
                ExpirationDate: '2027-07-01',
                AutoRenew: 'N',
              },
            ],
          },
        },
      }),
    );

    const provider = new DynadotRegistrarProvider(validConfig);
    const domains = await provider.listDomains();

    expect(domains).toHaveLength(2);
    expect(domains[0]?.domain).toBe('alpha.com');
    expect(domains[0]?.autoRenew).toBe(true);
    expect(domains[1]?.domain).toBe('beta.io');
    expect(domains[1]?.autoRenew).toBe(false);
  });

  it('listDomains returns empty on no domains', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        DynadotApiResponse: {
          Head: { ResultCode: '1', Status: 'success' },
          Body: {},
        },
      }),
    );

    const provider = new DynadotRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('listDomains returns empty on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        DynadotApiResponse: {
          Head: { ResultCode: '0', Status: 'error' },
          Body: {},
        },
      }),
    );

    const provider = new DynadotRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    const provider = new DynadotRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(8.99);
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    const provider = new DynadotRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.museum')).rejects.toThrow(
      /Unknown renewal pricing/,
    );
  });
});
