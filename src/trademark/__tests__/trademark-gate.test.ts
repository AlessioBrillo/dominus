// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { TrademarkGate, GateVerdict, STRICT_USPTO_TLDS } from '../trademark-gate.js';
import type { TrademarkProvider } from '../../providers/trademark/trademark-provider.js';
import type { TrademarkMatch } from '../../providers/trademark/trademark-provider.js';
import { ProviderError } from '../../types/errors.js';

function mockProvider(
  matches: { markName: string; owner: string; status: string; source: string }[],
): TrademarkProvider {
  return { search: vi.fn().mockResolvedValue(matches) };
}

function errorProvider(): TrademarkProvider {
  return { search: vi.fn().mockRejectedValue(new ProviderError('unavailable', 'test')) };
}

/** Provider that never settles on its own — rejects only when the signal aborts. */
function hangingProvider(): TrademarkProvider {
  return {
    search: (_term: string, signal?: AbortSignal) =>
      new Promise<TrademarkMatch[]>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      }),
  };
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

describe('TrademarkGate — parallel execution', () => {
  function deferredProvider(): { provider: TrademarkProvider; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<TrademarkMatch[]>((r) => {
      resolve = (): void => r([]);
    });
    return { provider: { search: vi.fn().mockReturnValue(promise) }, resolve };
  }

  it('invokes both sources before either resolves (parallel, not sequential)', async () => {
    const usp = deferredProvider();
    const eup = deferredProvider();
    const gate = new TrademarkGate(usp.provider, eup.provider);

    const checkPromise = gate.check('nova.io');
    expect(usp.provider.search).toHaveBeenCalled();
    expect(eup.provider.search).toHaveBeenCalled();

    usp.resolve();
    eup.resolve();
    const result = await checkPromise;
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.verifiedSources).toEqual(['USPTO', 'EUIPO']);
  });
});

describe('TrademarkGate — provider deadline (TRADEMARK_PROVIDER_TIMEOUT_MS)', () => {
  it('bounds a hung provider: timeout counts as provider failure, not a hang', async () => {
    const gate = new TrademarkGate(hangingProvider(), hangingProvider(), undefined, {
      providerTimeoutMs: 30,
    });

    const startedAt = Date.now();
    const result = await gate.check('nova.io');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.verifiedSources).toEqual([]);
  });

  it('deadline on a strict-TLD domain forces Unverified via usptoFailed (conservative)', async () => {
    const gate = new TrademarkGate(hangingProvider(), mockProvider([]), undefined, {
      providerTimeoutMs: 30,
    });

    const result = await gate.check('alpha.com');
    expect(result.verdict).toBe(GateVerdict.Unverified);
    expect(result.usptoFailed).toBe(true);
    expect(result.verifiedSources).toEqual(['EUIPO']);
  });

  it('deadline on a non-strict TLD degrades gracefully to Clear (partial)', async () => {
    const gate = new TrademarkGate(hangingProvider(), mockProvider([]), undefined, {
      providerTimeoutMs: 30,
    });

    const result = await gate.check('alpha.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(result.partial).toBe(true);
    expect(result.usptoFailed).toBeUndefined();
  });

  it('does not mask caller cancellation: aborting the run signal still propagates', async () => {
    const gate = new TrademarkGate(hangingProvider(), hangingProvider(), undefined, {
      providerTimeoutMs: 5000,
    });
    const ac = new AbortController();

    const checkPromise = gate.check('nova.io', ac.signal);
    setTimeout(() => ac.abort(), 10);

    await expect(checkPromise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('TrademarkGate — telemetry callback', () => {
  it('emits stats with verdict, source health and duration', async () => {
    const onResult = vi.fn();
    const gate = new TrademarkGate(mockProvider([]), errorProvider(), undefined, {
      onResult,
    });

    const result = await gate.check('nova.io');

    expect(result.verdict).toBe(GateVerdict.Clear);
    expect(onResult).toHaveBeenCalledTimes(1);
    const stats = onResult.mock.calls[0]![0];
    expect(stats.domain).toBe('nova.io');
    expect(stats.verdict).toBe(GateVerdict.Clear);
    expect(stats.partial).toBe(true);
    expect(stats.usptoOk).toBe(true);
    expect(stats.euipoOk).toBe(false);
    expect(typeof stats.durationMs).toBe('number');
  });

  it('emits stats on Blocked verdicts with matched source health', async () => {
    const onResult = vi.fn();
    const gate = new TrademarkGate(
      mockProvider([
        { markName: 'nova', owner: 'Nova Corp', status: 'registered', source: 'USPTO' },
      ]),
      mockProvider([]),
      undefined,
      { onResult },
    );

    await gate.check('nova.io');

    expect(onResult).toHaveBeenCalledTimes(1);
    const stats = onResult.mock.calls[0]![0];
    expect(stats.verdict).toBe(GateVerdict.Blocked);
    expect(stats.usptoOk).toBe(true);
    expect(stats.euipoOk).toBe(true);
  });

  it('a throwing telemetry callback does not break the gate', async () => {
    const gate = new TrademarkGate(mockProvider([]), mockProvider([]), undefined, {
      onResult: (): never => {
        throw new Error('broken sink');
      },
    });

    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
  });

  it('works without an onResult callback (default no-op)', async () => {
    const gate = new TrademarkGate(mockProvider([]), mockProvider([]));
    const result = await gate.check('nova.io');
    expect(result.verdict).toBe(GateVerdict.Clear);
  });
});
