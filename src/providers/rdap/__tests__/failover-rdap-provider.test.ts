import { describe, it, expect, vi } from 'vitest';
import { FailoverRdapProvider } from '../failover-rdap-provider.js';
import type { RdapProvider } from '../rdap-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { ProviderError } from '../../../types/errors.js';

function makeProvider(name: string, result: unknown, delayMs = 10): RdapProvider {
  return {
    name,
    confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

/**
 * Create a provider that always fails with the given error, for circuit
 * breaker testing. Uses a small delay so it doesn't race past other providers.
 */
function makeFailingProvider(name: string, delayMs = 5): RdapProvider {
  return {
    name,
    confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(`${name} failure`);
    }),
  };
}

/**
 * Create a provider that always succeeds, for circuit breaker testing.
 */
function makeHealthyProvider(name: string, delayMs = 5): RdapProvider {
  return {
    name,
    confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return {
        domain: 'example.com',
        status: DomainStatus.Registered,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      };
    }),
  };
}

function makeSlowHealthyProvider(name: string, delayMs = 50): RdapProvider {
  return makeHealthyProvider(name, delayMs);
}

describe('FailoverRdapProvider', () => {
  it('returns result from first provider on success', async () => {
    const primary = makeProvider('primary', {
      domain: 'example.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([primary]);
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Available);
    expect(primary.confirm).toHaveBeenCalledOnce();
  });

  it('falls back to second provider when first fails', async () => {
    const first = makeProvider('rdap.org', new ProviderError('timeout', 'rdap.org'));
    const second = makeProvider('verisign-rdap', {
      domain: 'example.com',
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([first, second]);
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Registered);
    // Sequential: both are called, first fails, second succeeds
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).toHaveBeenCalledTimes(1);
  });

  it('returns first provider result when multiple providers race in parallel', async () => {
    const first = makeProvider('primary', {
      domain: 'example.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const second = makeProvider('unused', {
      domain: 'example.com',
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([first, second]);
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Available);
    expect(first.confirm).toHaveBeenCalledTimes(1);
    // Parallel: all providers are called, first win returned
    expect(second.confirm).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderError when all servers fail', async () => {
    const providers = [
      makeProvider('a', new ProviderError('timeout', 'a')),
      makeProvider('b', new ProviderError('connection refused', 'b')),
    ];

    const provider = new FailoverRdapProvider(providers);
    await expect(provider.confirm('example.com')).rejects.toThrow(ProviderError);
    await expect(provider.confirm('example.com')).rejects.toThrow(
      /All RDAP bootstrap servers failed/,
    );
  });

  it('stops when signal is aborted before any response', async () => {
    const slowProvider: RdapProvider = {
      name: 'slow',
      confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(resolve, 200);
        });
        return {
          domain: 'example.com',
          status: DomainStatus.Registered,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        };
      }),
    };

    const provider = new FailoverRdapProvider([slowProvider]);
    const controller = new AbortController();
    const promise = provider.confirm('example.com', controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('propagates name property correctly', () => {
    const provider = new FailoverRdapProvider([
      makeProvider('first', {}),
      makeProvider('second', {}),
    ]);
    expect(provider.name).toContain('first');
    expect(provider.name).toContain('second');
  });

  it('builds provider list from URLs via fromConfig', () => {
    const provider = FailoverRdapProvider.fromConfig([
      'https://rdap.org/domain/',
      'https://rdap.verisign.com/com/domain/',
    ]);

    expect(provider.name).toContain('rdap-server-1');
    expect(provider.name).toContain('rdap-server-2');
  });

  describe('per-server circuit breaker', () => {
    it('skips server whose circuit is open and falls back to healthy server', async () => {
      const failer = makeFailingProvider('fail-server', 5);
      const healer = makeSlowHealthyProvider('heal-server', 50);

      // Aggressive policy: opens after 1 failure, cooldown longer than test
      const provider = new FailoverRdapProvider([failer, healer], undefined, {
        failureThreshold: 1,
        windowMs: 60_000,
        cooldownMs: 120_000,
      });

      // First call: failer fails, healer succeeds
      const result1 = await provider.confirm('example.com');
      expect(result1.status).toBe(DomainStatus.Registered);
      expect(failer.confirm).toHaveBeenCalledTimes(1);
      expect(healer.confirm).toHaveBeenCalledTimes(1);

      provider.clearCache();
      vi.clearAllMocks();

      // Second call: failer's circuit is open, should be skipped entirely.
      // Only healer should be called. Confirm expected try behavior.
      const result2 = await provider.confirm('example.com');
      expect(result2.status).toBe(DomainStatus.Registered);
      // failer.confirm should NOT be called — circuit is open
      expect(failer.confirm).not.toHaveBeenCalled();
      expect(healer.confirm).toHaveBeenCalledTimes(1);
    });

    it('opens only the failing server circuit, healthy server unaffected', async () => {
      const healthy = makeHealthyProvider('healthy', 30);
      // Failing provider fails instantly (0 delay) so the failure is
      // always recorded before the healthy provider can win and cancel it.
      const failing = makeFailingProvider('failing', 0);

      // Policy: 2 failures in long window
      const provider = new FailoverRdapProvider([healthy, failing], undefined, {
        failureThreshold: 2,
        windowMs: 60_000,
        cooldownMs: 120_000,
      });

      // First call — failing fails immediately (1 failure), healthy wins
      const result1 = await provider.confirm('example.com');
      expect(result1.status).toBe(DomainStatus.Registered);
      expect(healthy.confirm).toHaveBeenCalledTimes(1);
      expect(failing.confirm).toHaveBeenCalledTimes(1);

      provider.clearCache();
      vi.clearAllMocks();

      // Second call — failing fails again (2 failures → circuit opens),
      // healthy wins
      const result2 = await provider.confirm('example.com');
      expect(result2.status).toBe(DomainStatus.Registered);
      expect(failing.confirm).toHaveBeenCalledTimes(1);
      expect(healthy.confirm).toHaveBeenCalledTimes(1);

      provider.clearCache();
      vi.clearAllMocks();

      // Third call — failing circuit is open, skipped.
      // Only the healthy provider is called.
      const result3 = await provider.confirm('example.com');
      expect(result3.status).toBe(DomainStatus.Registered);
      expect(failing.confirm).not.toHaveBeenCalled();
      expect(healthy.confirm).toHaveBeenCalledTimes(1);
    });

    it('reports circuit open in error when all servers are down', async () => {
      const failer1 = makeFailingProvider('server-a', 5);
      const failer2 = makeFailingProvider('server-b', 5);

      const provider = new FailoverRdapProvider([failer1, failer2], undefined, {
        failureThreshold: 1,
        windowMs: 60_000,
        cooldownMs: 120_000,
      });

      // First call: both fail, circuit opens for both
      await expect(provider.confirm('example.com')).rejects.toThrow(ProviderError);

      provider.clearCache();
      vi.clearAllMocks();

      // Second call: both circuits open, no server called
      await expect(provider.confirm('example.com')).rejects.toThrow(
        /All RDAP bootstrap servers failed/,
      );
      await expect(provider.confirm('example.com')).rejects.toThrow(/circuit open/);
      expect(failer1.confirm).not.toHaveBeenCalled();
      expect(failer2.confirm).not.toHaveBeenCalled();
    });

    it('uses default per-server breaker policy when none provided', async () => {
      const provider = new FailoverRdapProvider();
      // Should not throw — the default RDAP_PER_SERVER_CIRCUIT_BREAKER
      // is used, and no circuit should open from one healthy call
      const result = await provider.confirm('example.com');
      expect(result).toBeDefined();
    });

    it('recovers after circuit cooldown — half-open allows retry', async () => {
      const failer = makeFailingProvider('flaky');
      const healer = makeHealthyProvider('stable');

      // Very short cooldown: 10ms — after the first failure, the circuit
      // opens immediately. After 10ms it transitions to half-open and
      // allows the server to be tried again.
      const provider = new FailoverRdapProvider([failer, healer], undefined, {
        failureThreshold: 1,
        windowMs: 30_000,
        cooldownMs: 10,
      });

      // First call: failer fails (circuit opens), healer wins
      await provider.confirm('example.com');
      expect(failer.confirm).toHaveBeenCalledTimes(1);

      provider.clearCache();
      vi.clearAllMocks();

      // Immediately after: circuit still open, failer skipped
      await provider.confirm('example.com');
      expect(failer.confirm).not.toHaveBeenCalled();

      provider.clearCache();
      vi.clearAllMocks();

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 20));

      // Next call: circuit half-open, failer is tried again
      const result = await provider.confirm('example.com');
      expect(result.status).toBe(DomainStatus.Registered);
      expect(failer.confirm).toHaveBeenCalledTimes(1);
    });
  });
});
