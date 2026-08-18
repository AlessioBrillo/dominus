// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { FailoverRdapProvider } from '../failover-rdap-provider.js';
import { IanaRdapBootstrap } from '../rdap-bootstrap.js';
import type { RdapProvider } from '../rdap-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { ProviderError } from '../../../types/errors.js';
import {
  CircuitBreaker,
  RDAP_PER_SERVER_CIRCUIT_BREAKER,
  type ICircuitBreaker,
} from '../../circuit-breaker.js';

// Counts confirm() calls on the bootstrap-derived authoritative servers.
// Shared via vi.hoisted so the vi.mock factories below can access it.
const { authCallCounter, constructedServers, constructedAgentPools } = vi.hoisted(() => ({
  authCallCounter: { count: 0 },
  constructedServers: [] as Array<{ url: string; tlds?: readonly string[] }>,
  constructedAgentPools: [] as unknown[],
}));

// Mock the IANA bootstrap: every TLD resolves to one authoritative server
// plus the rdap.org universal fallback (no network in unit tests).
vi.mock('../rdap-bootstrap.js', () => {
  const RDAP_ORG_UNIVERSAL = { name: 'rdap.org', baseUrl: 'https://rdap.org/', tlds: [] };
  return {
    IANA_RDAP_BOOTSTRAP_URL: 'https://data.iana.org/rdap/dns.json',
    RDAP_ORG_UNIVERSAL,
    IanaRdapBootstrap: class {
      async getServers(tld: string): Promise<unknown[]> {
        // One shared authoritative server (like rdap.verisign.com serving
        // .com and .net) plus the rdap.org universal fallback.
        return [
          { name: 'registry.example', baseUrl: 'https://registry.example/domain/', tlds: [tld] },
          RDAP_ORG_UNIVERSAL,
        ];
      }
    },
  };
});

// Mock the public RDAP client: rdap.org answers Registered, every other
// server fails — letting tests exercise the per-server circuit breaker on
// bootstrap-derived providers.
vi.mock('../public-rdap-provider.js', async () => {
  const { DomainStatus } = await import('../../../types/domain-status.js');
  return {
    DEFAULT_RDAP_MAX_RESPONSE_BYTES: 1_048_576,
    PublicRdapProvider: class {
      readonly name: string;
      constructor(
        url: string,
        name: string,
        _limiter?: unknown,
        _timeout?: unknown,
        tlds?: readonly string[],
        agentPool?: unknown,
      ) {
        this.name = name;
        constructedServers.push(tlds === undefined ? { url } : { url, tlds });
        constructedAgentPools.push(agentPool);
      }
      async confirm(domain: string): Promise<unknown> {
        authCallCounter.count++;
        if (this.name === 'rdap.org') {
          return {
            domain,
            status: DomainStatus.Registered,
            isPremium: false,
            checkedAt: new Date().toISOString(),
          };
        }
        throw new Error(`${this.name} failure`);
      }
      clearCache(): void {}
    },
  };
});

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

  it('passes per-TLD scope from fromConfig entries to the underlying servers', () => {
    // Regression: custom servers were built as universal authorities, so a
    // 404 from rdap.verisign.com on a .io domain was read as "Available".
    constructedServers.length = 0;
    FailoverRdapProvider.fromConfig([
      'https://rdap.org/domain/',
      { url: 'https://rdap.verisign.com/com/domain/', tlds: ['com', 'net'] },
    ]);

    expect(constructedServers).toEqual([
      { url: 'https://rdap.org/domain/' },
      { url: 'https://rdap.verisign.com/com/domain/', tlds: ['com', 'net'] },
    ]);
  });

  it('propagates the shared agent pool from fromConfig to every server (ADR-0049)', () => {
    const pool = { maxConnections: 64 } as never;
    constructedAgentPools.length = 0;
    FailoverRdapProvider.fromConfig(
      ['https://rdap.org/domain/', 'https://rdap.verisign.com/com/domain/'],
      undefined,
      undefined,
      undefined,
      pool,
    );

    expect(constructedAgentPools).toEqual([pool, pool]);
  });

  it('propagates the shared agent pool from withDefaults to the universal server (ADR-0049)', () => {
    const pool = { maxConnections: 64 } as never;
    constructedAgentPools.length = 0;
    FailoverRdapProvider.withDefaults(undefined, undefined, undefined, undefined, pool);

    expect(constructedAgentPools).toEqual([pool]);
  });

  it('propagates the shared agent pool to bootstrap-derived servers (ADR-0049)', async () => {
    const pool = { maxConnections: 64 } as never;
    constructedAgentPools.length = 0;
    const provider = new FailoverRdapProvider(
      undefined,
      undefined,
      undefined,
      new IanaRdapBootstrap('https://data.iana.org/rdap/dns.json'),
      undefined,
      pool,
    );

    await provider.confirm('example.com');

    // The rdap.org universal fallback plus the TLD's authoritative server.
    expect(constructedAgentPools.length).toBeGreaterThanOrEqual(2);
    expect(constructedAgentPools.every((p) => p === pool)).toBe(true);

    // Do not leak confirm() calls into the bootstrap suite that follows.
    authCallCounter.count = 0;
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
      const healthy = makeHealthyProvider('healthy');
      const provider = new FailoverRdapProvider([healthy]);
      // Should not throw — the default RDAP_PER_SERVER_CIRCUIT_BREAKER
      // is used, and no circuit should open from one healthy call
      const result = await provider.confirm('example.com');
      expect(result).toBeDefined();
      expect(healthy.confirm).toHaveBeenCalledTimes(1);
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

  describe('per-TLD bootstrap servers', () => {
    it('registers a circuit breaker for bootstrap-derived servers', async () => {
      const universal = makeHealthyProvider('rdap.org', 10);
      const provider = new FailoverRdapProvider(
        [universal],
        undefined,
        { failureThreshold: 1, windowMs: 60_000, cooldownMs: 120_000 },
        new IanaRdapBootstrap(),
      );

      // Phase 1: authoritative-xyz fails once (breaker opens), the
      // universal fallback answers Registered.
      const result1 = await provider.confirm('example.xyz');
      expect(result1.status).toBe(DomainStatus.Registered);
      expect(authCallCounter.count).toBe(1);

      provider.clearCache();
      vi.clearAllMocks();
      authCallCounter.count = 0;

      // Phase 2: the authoritative server's circuit is open — it must be
      // skipped entirely, only the universal fallback is queried.
      const result2 = await provider.confirm('example.xyz');
      expect(result2.status).toBe(DomainStatus.Registered);
      expect(authCallCounter.count).toBe(0);
      expect(universal.confirm).toHaveBeenCalledTimes(1);
    });

    it('shares one breaker across TLDs served by the same server', async () => {
      const universal = makeHealthyProvider('rdap.org', 10);
      const provider = new FailoverRdapProvider(
        [universal],
        undefined,
        { failureThreshold: 1, windowMs: 60_000, cooldownMs: 120_000 },
        new IanaRdapBootstrap(),
      );

      // One failure for .xyz opens the shared breaker (keyed by server
      // name) — .net must now skip the authoritative server too.
      await provider.confirm('example.xyz');
      expect(authCallCounter.count).toBe(1);

      provider.clearCache();
      vi.clearAllMocks();
      authCallCounter.count = 0;

      const result = await provider.confirm('example.net');
      expect(result.status).toBe(DomainStatus.Registered);
      expect(authCallCounter.count).toBe(0);
    });
  });

  describe('injected breaker factory (distributed mode)', () => {
    it('uses the factory and awaits an async allow() before skipping a server', async () => {
      // An async allow() (Promise) is the contract of the distributed
      // breaker; the failover loop must await it, or an open circuit would
      // be treated as allowed and every server would be hit.
      const allow = vi.fn().mockResolvedValue(false);
      const fakeBreaker: ICircuitBreaker = {
        allow,
        onSuccess: vi.fn(),
        onFailure: vi.fn(),
        state: 'open',
        cooldownMs: 1000,
      };
      const factory = vi.fn().mockReturnValue(fakeBreaker);

      const failing = makeFailingProvider('rdap-server-1', 5);
      const healthy = makeHealthyProvider('rdap.org', 5);
      const provider = new FailoverRdapProvider(
        [healthy, failing],
        undefined,
        undefined,
        undefined,
        factory,
      );

      await expect(provider.confirm('example.com')).rejects.toThrow(/circuit open/);
      expect(factory).toHaveBeenCalled();
      expect(healthy.confirm).not.toHaveBeenCalled();
      expect(failing.confirm).not.toHaveBeenCalled();
    });

    it('uses the injected factory for bootstrap-derived servers', async () => {
      const factory = vi.fn(
        (_name: string): ICircuitBreaker => new CircuitBreaker(RDAP_PER_SERVER_CIRCUIT_BREAKER),
      );
      const universal = makeHealthyProvider('rdap.org', 10);
      const provider = new FailoverRdapProvider(
        [universal],
        undefined,
        undefined,
        new IanaRdapBootstrap('https://bootstrap.example/dns.json'),
        factory,
      );

      await provider.confirm('example.com');

      const names = factory.mock.calls.map((c) => String(c[0]));
      expect(names).toContain('registry.example');
      expect(names).toContain('rdap.org');
    });
  });
});
