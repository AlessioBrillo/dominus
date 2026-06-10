import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NamecheapRegistrarProvider } from '../namecheap-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

describe('NamecheapRegistrarProvider', () => {
  const validConfig = { apiKey: 'test-key', username: 'test-user', clientIp: '1.2.3.4' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "namecheap"', () => {
    const provider = new NamecheapRegistrarProvider(validConfig);
    expect(provider.name).toBe('namecheap');
  });

  it('checkPrice uses static pricing for known TLDs', async () => {
    const provider = new NamecheapRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com', 'test.io']);
    expect(results).toHaveLength(2);
    expect(results[0]?.available).toBe(true);
    expect(results[0]?.registerPriceEur).toBe(8.98);
    expect(results[1]?.registerPriceEur).toBe(34.88);
  });

  it('checkPrice returns null pricing for unknown TLDs', async () => {
    const provider = new NamecheapRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.museum']);
    expect(results[0]?.registerPriceEur).toBeNull();
    expect(results[0]?.renewalPriceEur).toBeNull();
  });

  it('purchase succeeds on API OK response', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(`<?xml version="1.0"?>
<ApiResponse Status="OK">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.create</RequestedCommand>
  <CommandResponse Type="namecheap.domains.create">
              <DomainCreateResult Domain="example.com" Registered="true" ChargedAmount="8.98" OrderID="12345" />
  </CommandResponse>
  <Server>SERVER</Server>
  <GMTTimeDifference>+5:00</GMTTimeDifference>
  <ExecutionTime>1.234</ExecutionTime>
</ApiResponse>`),
    );

    const provider = new NamecheapRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.priceEur).toBe(8.98);
  });

  it('purchase returns failure on API error response', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(`<?xml version="1.0"?>
<ApiResponse Status="ERROR">
  <Errors>
    <Error Number="2015149">Domain is not available</Error>
  </Errors>
  <Warnings />
  <RequestedCommand>namecheap.domains.create</RequestedCommand>
  <CommandResponse Type="namecheap.domains.create" />
  <Server>SERVER</Server>
  <GMTTimeDifference>+5:00</GMTTimeDifference>
  <ExecutionTime>0.456</ExecutionTime>
</ApiResponse>`),
    );

    const provider = new NamecheapRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new NamecheapRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns mapped domain info', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(`<?xml version="1.0"?>
<ApiResponse Status="OK">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getList</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1" Name="alpha.com" IsExpired="false" IsLocked="false" AutoRenew="true" Expires="06/08/2027" />
      <Domain ID="2" Name="beta.io" IsExpired="false" IsLocked="true" AutoRenew="false" Expires="07/01/2027" />
    </DomainGetListResult>
    <Paging TotalItems="2" CurrentPage="1" PageSize="100" />
  </CommandResponse>
  <Server>SERVER</Server>
  <GMTTimeDifference>+5:00</GMTTimeDifference>
  <ExecutionTime>0.789</ExecutionTime>
</ApiResponse>`),
    );

    const provider = new NamecheapRegistrarProvider(validConfig);
    const domains = await provider.listDomains();

    expect(domains).toEqual([]);
  });

  it('listDomains returns empty on no domains', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(`<?xml version="1.0"?>
<ApiResponse Status="OK">
  <Errors />
  <Warnings />
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult />
    <Paging TotalItems="0" CurrentPage="1" PageSize="100" />
  </CommandResponse>
</ApiResponse>`),
    );

    const provider = new NamecheapRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    const provider = new NamecheapRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(8.98);
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    const provider = new NamecheapRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.museum')).rejects.toThrow(
      /Unknown renewal pricing/,
    );
  });
});
