import { describe, it, expect, vi } from 'vitest';
import { TrademarkGate, GateVerdict, STRICT_USPTO_TLDS } from '../trademark-gate.js';
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
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(false);
    expect(result.verifiedSources).toEqual(['USPTO', 'EUIPO']);
    expect(result.usptoFailed).toBeUndefined();
  });

  it('returns Clear (partial) when EUIPO is down but USPTO returns no matches', async () => {
    const gate = new TrademarkGate(mockProvider([]), errorProvider());
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.verifiedSources).toEqual(['USPTO']);
    expect(result.usptoFailed).toBeUndefined();
  });

  // --- Blocked cases ---

  it('returns Blocked when USPTO has a matching mark', async () => {
    const gate = new TrademarkGate(
      mockProvider([
        { markName: 'nova', owner: 'Nova Corp', status: 'registered', source: 'USPTO' },
      ]),
      mockProvider([]),
    );
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchedMark).toBe('nova');
    expect(result.matchedOwner).toBe('Nova Corp');
  });

  it('returns Blocked when EUIPO has a matching mark', async () => {
    const gate = new TrademarkGate(
      mockProvider([]),
      mockProvider([
        { markName: 'Apple', owner: 'Apple Inc', status: 'registered', source: 'EUIPO' },
      ]),
    );
    const result = await gate.check('apple.io');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchSource).toBe('EUIPO');
  });

  it('returns Blocked even when one provider errors but the other has a match', async () => {
    const gate = new TrademarkGate(
      errorProvider(),
      mockProvider([{ markName: 'nova', owner: 'X', status: 'registered', source: 'EUIPO' }]),
    );
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Blocked);
  });

  // --- Unverified cases ---

  it('returns Unverified when all providers error (Principle 6: cannot confirm clearance)', async () => {
    const gate = new TrademarkGate(errorProvider(), errorProvider());
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.verifiedSources).toEqual([]);
  });
});

describe('TrademarkGate — strict USPTO TLDs (ADR-0012)', () => {
  it('lists .com and .us as the strict TLDs', () => {
    expect(STRICT_USPTO_TLDS.has('.com')).toBe(true);
    expect(STRICT_USPTO_TLDS.has('.us')).toBe(true);
    expect(STRICT_USPTO_TLDS.has('.io')).toBe(false);
    expect(STRICT_USPTO_TLDS.has('.ai')).toBe(false);
  });

  it('forces Unverified on .com when USPTO is unreachable, even if EUIPO is clear', async () => {
    const gate = new TrademarkGate(errorProvider(), mockProvider([]));
    const result = await gate.check('alpha.com');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.usptoFailed).toBe(true);
    expect(result.verifiedSources).toEqual(['EUIPO']);
  });

  it('forces Unverified on .us when USPTO is unreachable, even if EUIPO is clear', async () => {
    const gate = new TrademarkGate(errorProvider(), mockProvider([]));
    const result = await gate.check('alpha.us');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.usptoFailed).toBe(true);
  });

  it('forces Unverified on a deep .com subdomain when USPTO is unreachable', async () => {
    const gate = new TrademarkGate(errorProvider(), mockProvider([]));
    const result = await gate.check('shop.us.alpha.com');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.usptoFailed).toBe(true);
  });

  it('keeps graceful degrade for non-strict TLDs (.io) when only EUIPO responds', async () => {
    // Outside the strict set, EUIPO alone is enough to clear a domain.
    const gate = new TrademarkGate(errorProvider(), mockProvider([]));
    const result = await gate.check('alpha.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.verifiedSources).toEqual(['EUIPO']);
    expect(result.usptoFailed).toBeUndefined();
  });

  it('does NOT mark usptoFailed when both providers answer cleanly on .com', async () => {
    const gate = new TrademarkGate(mockProvider([]), mockProvider([]));
    const result = await gate.check('alpha.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.usptoFailed).toBeUndefined();
  });

  it('does NOT mark usptoFailed when USPTO is up and EUIPO is down on .com', async () => {
    const gate = new TrademarkGate(mockProvider([]), errorProvider());
    const result = await gate.check('alpha.com');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.usptoFailed).toBeUndefined();
  });

  it('still returns Blocked on .com when EUIPO finds a mark, even if USPTO is down', async () => {
    // Block always wins over strict-TLD Unverified: if we have a real
    // EUIPO match we should not pretend we are Unverified, we should
    // block the candidate. The strict-TLD rule is a fallback, not a
    // override of the Block path.
    const gate = new TrademarkGate(
      errorProvider(),
      mockProvider([
        { markName: 'alpha', owner: 'Alpha Corp', status: 'registered', source: 'EUIPO' },
      ]),
    );
    const result = await gate.check('alpha.com');
    expect(result.verdict).toBe(GateVerdict.Blocked);
    expect(result.matchedMark).toBe('alpha');
    expect(result.matchSource).toBe('EUIPO');
  });
});

describe('TrademarkGate — abort signal', () => {
  it('passes the AbortSignal to both providers', async () => {
    const usp = { search: vi.fn().mockResolvedValue([]) };
    const eup = { search: vi.fn().mockResolvedValue([]) };
    const gate = new TrademarkGate(usp, eup);
    const ac = new AbortController();

    await gate.check('test.io', ac.signal);

    expect(usp.search).toHaveBeenCalledWith('test', ac.signal);
    expect(eup.search).toHaveBeenCalledWith('test', ac.signal);
  });

  it('re-throws AbortError from provider', async () => {
    const usp = {
      search: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
    };
    const eup = { search: vi.fn().mockResolvedValue([]) };
    const gate = new TrademarkGate(usp, eup);

    let err: unknown;
    try {
      await gate.check('test.io', AbortSignal.abort());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
