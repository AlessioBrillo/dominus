import { describe, it, expect } from 'vitest';
import { ManualCompsProvider } from '../manual-comps-provider.js';

describe('ManualCompsProvider', () => {
  it('returns empty array when no data file', async () => {
    const provider = new ManualCompsProvider();
    const sales = await provider.getSales('app');
    expect(sales).toEqual([]);
  });

  it('returns empty array for unmatched term', async () => {
    const provider = new ManualCompsProvider();
    const sales = await provider.getSales('xyzqwerty');
    expect(sales).toEqual([]);
  });
});
