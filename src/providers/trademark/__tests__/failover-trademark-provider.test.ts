import { describe, it, expect, vi } from 'vitest';
import { FailoverTrademarkProvider } from '../failover-trademark-provider.js';
import { ProviderError } from '../../../types/errors.js';
import type { TrademarkProvider, TrademarkMatch } from '../trademark-provider.js';

function createMockProvider(results?: TrademarkMatch[], fail?: boolean): TrademarkProvider {
  return {
    search: vi.fn().mockImplementation(async (_term: string, _signal?: AbortSignal) => {
      if (fail) throw new ProviderError('mock failed', 'MockProvider', 'TM_PROVIDER_ERROR');
      return results ?? [];
    }),
  };
}

describe('FailoverTrademarkProvider', () => {
  it('throws if constructed with empty providers array', () => {
    expect(() => new FailoverTrademarkProvider([])).toThrow(
      'FailoverTrademarkProvider requires at least one provider',
    );
  });

  it('returns results from the first provider', async () => {
    const match: TrademarkMatch = {
      markName: 'TESTMARK',
      owner: 'Test Owner',
      status: 'REGISTERED',
      source: 'USPTO' as const,
      registrationNumber: '12345',
    };
    const p1 = createMockProvider([match]);
    const p2 = createMockProvider([]);
    const provider = new FailoverTrademarkProvider([p1, p2]);

    const results = await provider.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('TESTMARK');
    expect(p1.search).toHaveBeenCalledOnce();
    expect(p2.search).not.toHaveBeenCalled();
  });

  it('fails over to subsequent provider when the first fails', async () => {
    const match: TrademarkMatch = {
      markName: 'FALLBACK',
      owner: 'Fallback Owner',
      status: 'REGISTERED',
      source: 'EUIPO' as const,
      registrationNumber: '67890',
    };
    const p1 = createMockProvider([], true);
    const p2 = createMockProvider([match]);
    const provider = new FailoverTrademarkProvider([p1, p2]);

    const results = await provider.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('FALLBACK');
    expect(p1.search).toHaveBeenCalledOnce();
    expect(p2.search).toHaveBeenCalledOnce();
  });

  it('throws ProviderError when all providers fail', async () => {
    const p1 = createMockProvider([], true);
    const p2 = createMockProvider([], true);
    const provider = new FailoverTrademarkProvider([p1, p2]);

    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
    const err = await provider.search('test').catch((e) => e);
    expect((err as ProviderError).code).toBe('TM_FAILOVER_EXHAUSTED');
  });

  it('sets name from constructor names of wrapped providers', () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    const provider = new FailoverTrademarkProvider([p1, p2]);

    expect(provider.name).toMatch(/FailoverTrademarkProvider\(/);
  });

  it('throws AbortError if signal is already aborted before search', async () => {
    const p1 = createMockProvider();
    const provider = new FailoverTrademarkProvider([p1]);
    const signal = AbortSignal.abort();

    await expect(provider.search('test', signal)).rejects.toThrow('Aborted');
    expect(p1.search).not.toHaveBeenCalled();
  });

  it('throws AbortError if signal is aborted between provider attempts', async () => {
    const ctrl = new AbortController();
    const p1 = createMockProvider([], true);
    const p2 = createMockProvider();
    const provider = new FailoverTrademarkProvider([p1, p2]);

    const promise = provider.search('test', ctrl.signal);
    ctrl.abort();

    await expect(promise).rejects.toThrow('Aborted');
  });
});
