import { describe, it, expect } from 'vitest';
import { ManualRegistrarProvider } from '../manual-registrar-provider.js';

describe('ManualRegistrarProvider', () => {
  const provider = new ManualRegistrarProvider();

  it('has name set to "manual"', () => {
    expect(provider.name).toBe('manual');
  });

  it('checkPrice returns undetermined for every domain', async () => {
    const results = await provider.checkPrice(['example.com', 'test.io']);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.available).toBe(true);
      expect(r.registerPriceEur).toBeNull();
      expect(r.renewalPriceEur).toBeNull();
      expect(r.transferPriceEur).toBeNull();
    }
  });

  it('checkPrice returns timestamps', async () => {
    const results = await provider.checkPrice(['example.com']);
    expect(results[0]?.checkedAt).toBeTruthy();
    expect(() => new Date(results[0]!.checkedAt)).not.toThrow();
  });

  it('purchase returns recording success with manual message', async () => {
    const result = await provider.purchase({ domain: 'example.com', years: 1 });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/portfolio update-costs/);
    expect(result.priceEur).toBe(0);
  });

  it('listDomains returns empty array', async () => {
    const domains = await provider.listDomains();
    expect(domains).toEqual([]);
  });

  it('getRenewalCost returns 0', async () => {
    const cost = await provider.getRenewalCost('example.com');
    expect(cost).toBe(0);
  });
});
