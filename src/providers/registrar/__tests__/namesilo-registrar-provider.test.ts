import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NameSiloRegistrarProvider } from '../namesilo-registrar-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeXmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

describe('NameSiloRegistrarProvider', () => {
  const validConfig = { apiKey: 'test-key' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has name set to "namesilo"', () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    expect(provider.name).toBe('namesilo');
  });

  it('checkPrice uses static pricing for known TLDs', async () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.com', 'test.io']);
    expect(results).toHaveLength(2);
    expect(results[0]?.available).toBe(true);
    expect(results[0]?.registerPriceEur).toBe(6.99);
    expect(results[1]?.registerPriceEur).toBe(28.99);
  });

  it('checkPrice returns null pricing for unknown TLDs', async () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    const results = await provider.checkPrice(['example.museum']);
    expect(results[0]?.registerPriceEur).toBeNull();
  });

  it('purchase succeeds on API success', async () => {
    mockFetch.mockResolvedValueOnce(
      makeXmlResponse(`<?xml version="1.0"?>
<namesilo>
  <request>
    <operation>registerDomain</operation>
    <ip>1.2.3.4</ip>
  </request>
  <reply>
    <code>0</code>
    <detail>success</detail>
    <registerDomain>
      <order_id>ord-123</order_id>
      <domain>example.com</domain>
              <price>6.99</price>
              <renewal_price>8.99</renewal_price>
      <years>1</years>
      <register_date>2026-06-10</register_date>
      <expires>2027-06-10</expires>
    </registerDomain>
  </reply>
</namesilo>`),
    );

    const provider = new NameSiloRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'example.com', years: 1 });

    expect(result.success).toBe(true);
    expect(result.priceEur).toBe(6.99);
  });

  it('purchase returns failure on API error (code 300)', async () => {
    mockFetch.mockResolvedValueOnce(
      makeXmlResponse(`<?xml version="1.0"?>
<namesilo>
  <request>
    <operation>registerDomain</operation>
  </request>
  <reply>
    <code>300</code>
    <detail>Unable to register domain: Domain already taken</detail>
  </reply>
</namesilo>`),
    );

    const provider = new NameSiloRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'taken.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Domain already taken/);
  });

  it('purchase handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new NameSiloRegistrarProvider(validConfig);
    const result = await provider.purchase({ domain: 'error.com', years: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network failure/);
  });

  it('listDomains returns empty array (not implemented)', async () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns pricing for known TLD', async () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(8.99);
  });

  it('getRenewalCost throws for unknown TLD', async () => {
    const provider = new NameSiloRegistrarProvider(validConfig);
    await expect(provider.getRenewalCost('example.museum')).rejects.toThrow(
      /Unknown renewal pricing/,
    );
  });
});
