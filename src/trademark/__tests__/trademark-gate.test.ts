import { describe, it, expect, vi } from 'vitest';
import { TrademarkGate, GateVerdict } from '../trademark-gate.js';
import type { TrademarkProvider } from '../../providers/trademark/trademark-provider.js';
import { ProviderError } from '../../types/errors.js';

function mockProvider(
  matches: { markName: string; owner: string; status: string; source: string }[],
): TrademarkProvider {
  return { search: vi.fn().mockResolvedValue(matches) };
}

function errorProvider(): TrademarkProvider {
  return { search: vi.fn().mockRejectedValue(new ProviderError('unavailable', 'test')) };
}

describe('TrademarkGate', () => {
  // --- Clear cases ---

  it('returns Clear (non-partial) when both providers respond with no matches', async () => {
    const gate = new TrademarkGate(mockProvider([]), mockProvider([]));
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(false);
    expect(result.verifiedSources).toEqual(['USPTO', 'EUIPO']);
  });

  it('returns Clear (partial) when USPTO is down but EUIPO returns no matches', async () => {
    const gate = new TrademarkGate(errorProvider(), mockProvider([]));
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.verifiedSources).toEqual(['EUIPO']);
  });

  it('returns Clear (partial) when EUIPO is down but USPTO returns no matches', async () => {
    const gate = new TrademarkGate(mockProvider([]), errorProvider());
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.verifiedSources).toEqual(['USPTO']);
  });

  // --- Blocked cases ---

  it('returns Blocked when USPTO has a matching mark', async () => {
    const gate = new TrademarkGate(
      mockProvider([{ markName: 'nova', owner: 'Nova Corp', status: 'registered', source: 'USPTO' }]),
      mockProvider([]),
    );
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchedMark).toBe('nova');
    expect(result.matchedOwner).toBe('Nova Corp');
  });

  it('returns Blocked when EUIPO has a matching mark', async () => {
    const gate = new TrademarkGate(
      mockProvider([]),
      mockProvider([{ markName: 'Apple', owner: 'Apple Inc', status: 'registered', source: 'EUIPO' }]),
    );
    const result = await gate.check('apple.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchSource).toBe('EUIPO');
  });

  it('returns Blocked even when one provider errors but the other has a match', async () => {
    const gate = new TrademarkGate(
      errorProvider(),
      mockProvider([{ markName: 'nova', owner: 'X', status: 'registered', source: 'EUIPO' }]),
    );
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
  });

  // --- Unverified cases ---

  it('returns Unverified when all providers error (Principle 6: cannot confirm clearance)', async () => {
    const gate = new TrademarkGate(errorProvider(), errorProvider());
    const result = await gate.check('nova.com');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.verifiedSources).toEqual([]);
  });
});
