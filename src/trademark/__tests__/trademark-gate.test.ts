import { describe, it, expect, vi } from 'vitest';
import { TrademarkGate, GateVerdict } from '../trademark-gate.js';
import type { TrademarkProvider } from '../../providers/trademark/trademark-provider.js';
import { ProviderError } from '../../types/errors.js';

function mockProvider(matches: { markName: string; owner: string; status: string; source: string }[]): TrademarkProvider {
  return { search: vi.fn().mockResolvedValue(matches) };
}

function errorProvider(): TrademarkProvider {
  return { search: vi.fn().mockRejectedValue(new ProviderError('unavailable', 'test')) };
}

describe('TrademarkGate', () => {
  it('returns Clear when no matches from either provider', async () => {
    const gate = new TrademarkGate(mockProvider([]), mockProvider([]));
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
  });

  it('returns Blocked when USPTO matches', async () => {
    const gate = new TrademarkGate(
      mockProvider([{ markName: 'nova', owner: 'Nova Corp', status: 'registered', source: 'uspto' }]),
      mockProvider([]),
    );
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchedMark).toBe('nova');
  });

  it('returns Blocked when EUIPO matches', async () => {
    const gate = new TrademarkGate(
      mockProvider([]),
      mockProvider([{ markName: 'Apple', owner: 'Apple Inc', status: 'registered', source: 'euipo' }]),
    );
    const result = await gate.check('apple.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
  });

  it('returns Unverified when providers throw ProviderError', async () => {
    const gate = new TrademarkGate(errorProvider(), errorProvider());
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Unverified);
  });

  it('returns Blocked even if one provider errors but other has a match', async () => {
    const gate = new TrademarkGate(
      errorProvider(),
      mockProvider([{ markName: 'nova', owner: 'X', status: 'registered', source: 'euipo' }]),
    );
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
  });
});
