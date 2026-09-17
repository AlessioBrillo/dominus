// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Routes every Resolver.resolve() call through this mock, keyed by
 *  (domain, rrtype), so DNSSEC negative-control behavior is deterministic
 *  instead of depending on real network/Unbound reachability. */
const resolveFn = vi.fn<(domain: string, rrtype: string) => Promise<string[]>>();

vi.mock('node:dns', () => {
  class MockResolver {
    resolve(
      domain: string,
      rrtype: string,
      callback: (err: Error | null, addresses?: string[]) => void,
    ): void {
      resolveFn(domain, rrtype).then(
        (addresses: string[]) => callback(null, addresses),
        (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
      );
    }
    cancel(): void {}
    setServers(_servers: string[]): void {}
  }
  return { Resolver: MockResolver };
});

import {
  UnboundResolver,
  DNSSEC_POSITIVE_CONTROL,
  DNSSEC_NEGATIVE_CONTROL,
  DNSSEC_NEGATIVE_CONTROL_FALLBACK,
} from '../unbound-resolver.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { DnsCheckResult } from '../../../types/domain-status.js';
import type { ProviderCacheRepository } from '../../../db/repositories/provider-cache-repository.js';
import type { RateLimiterLike } from '../../../providers/rate-limiter.js';

/** Build an Error carrying a c-ares style `code`, as node:dns produces. */
function dnsError(code: string): Error {
  const err = new Error(code) as Error & { code?: string };
  err.code = code;
  return err;
}

describe('UnboundResolver', () => {
  let resolver: UnboundResolver;
  let mockCacheRepo: ProviderCacheRepository;
  let mockRateLimiter: RateLimiterLike;
  let mockMetrics: (stats: {
    durationMs: number;
    status: 'registered' | 'available' | 'unknown';
    dnssec: 'valid' | 'unchecked' | 'bogus';
    fromCache: boolean;
  }) => void;

  beforeEach(() => {
    resolveFn.mockReset();
    // Default: every domain resolves an A record ("registered"), except the
    // one name tests use to exercise the resolver-error (Unknown) path.
    // ECONNREFUSED, not ENOTFOUND: an NXDOMAIN answer on A/NS/SOA is a valid
    // "available" verdict, not an error — this simulates the resolver itself
    // being unreachable/misbehaving.
    resolveFn.mockImplementation((domain) => {
      if (domain === 'nonexistent.invalid') return Promise.reject(dnsError('ECONNREFUSED'));
      return Promise.resolve(['1.2.3.4']);
    });

    mockCacheRepo = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      prune: vi.fn().mockResolvedValue(0),
    } as unknown as ProviderCacheRepository;

    mockRateLimiter = {
      acquire: vi.fn().mockResolvedValue(undefined),
      maxTokens: 20,
      tokensPerInterval: 20,
      intervalMs: 1000,
    } as unknown as RateLimiterLike;

    mockMetrics = vi.fn();

    resolver = new UnboundResolver({
      unboundHosts: ['127.0.0.1', '::1'],
      lookupTimeoutMs: 1500,
      cacheTtlMs: 300_000,
      maxSize: 10000,
      bulkConcurrency: 200,
      parkingEnabled: false,
      rateLimiter: mockRateLimiter,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
      persistentCache: mockCacheRepo,
      persistentCacheTtlHours: 168,
      persistentAvailableStaleMs: 24 * 60 * 60_000,
      dnssecValidationEnabled: true,
      onResolution: mockMetrics,
    });
  });

  afterEach(() => {
    resolver.dispose();
  });

  describe('constructor', () => {
    it('should create resolver with default options', () => {
      const r = new UnboundResolver({ unboundHosts: ['127.0.0.1'] });
      expect(r.name).toBe('UnboundResolver');
      r.dispose();
    });

    it('should throw when unboundHosts is empty', () => {
      expect(() => new UnboundResolver({ unboundHosts: [] })).toThrow();
    });

    it('should set cache disabled when maxSize <= 0', () => {
      const r = new UnboundResolver({ unboundHosts: ['127.0.0.1'], maxSize: 0 });
      r.clearCache(); // Should not throw
      r.dispose();
    });
  });

  describe('checkAvailability', () => {
    it('should return cached result from memory cache', async () => {
      await resolver.checkAvailability('example.com');
      const result = await resolver.checkAvailability('example.com');
      expect(result.domain).toBe('example.com');
      expect(result.status).toBe(DomainStatus.Registered);
      expect(result.checkedAt).toBeDefined();
    });

    it('should report fromCache=false on a live lookup and true on a memory-cache hit', async () => {
      await resolver.checkAvailability('example.com');
      expect(mockMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ fromCache: false }));

      await resolver.checkAvailability('example.com');
      expect(mockMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ fromCache: true }));
    });

    it('should return cached result from persistent cache', async () => {
      const cachedResult: DnsCheckResult = {
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        dnssec: 'valid',
      };

      (mockCacheRepo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        JSON.stringify(cachedResult),
      );

      const result = await resolver.checkAvailability('example.com');
      expect(result).toEqual(cachedResult);
      expect(mockCacheRepo.get).toHaveBeenCalledWith('example.com', 'UnboundResolver');
      expect(mockMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'registered',
          fromCache: true,
        }),
      );
    });

    it('should skip persistent cache when forceRecheck is true', async () => {
      const cachedResult: DnsCheckResult = {
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        dnssec: 'valid',
      };

      (mockCacheRepo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        JSON.stringify(cachedResult),
      );

      await resolver.checkAvailability('example.com', undefined, {
        forceRecheck: true,
      });

      expect(mockCacheRepo.get).not.toHaveBeenCalled();
    });

    it('should not persist Unknown results', async () => {
      await resolver.checkAvailability('nonexistent.invalid');
      expect(mockCacheRepo.set).not.toHaveBeenCalled();
    });
  });

  describe('checkBulk', () => {
    it('should return array of results for multiple domains', async () => {
      const domains = ['example.com', 'example.org', 'example.net'];
      const results = await resolver.checkBulk(domains);

      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.domain).toBeDefined();
        expect(r.status).toBe(DomainStatus.Registered);
        expect(r.checkedAt).toBeDefined();
      });
    });

    it('should respect abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(resolver.checkBulk(['example.com'], controller.signal)).rejects.toThrow(
        'Aborted',
      );
    });
  });

  describe('cache operations', () => {
    it('should clear cache', () => {
      resolver.clearCache();
    });

    it('should prune cache', () => {
      const pruned = resolver.pruneCache();
      expect(typeof pruned).toBe('number');
    });
  });

  describe('dispose', () => {
    it('should dispose without error', () => {
      expect(() => resolver.dispose()).not.toThrow();
    });

    it('should clear pending lookups on dispose', async () => {
      const promise = resolver.checkAvailability('example.com');
      resolver.dispose();
      const result = await promise;
      expect(result).toBeDefined();
    });
  });

  describe('per-domain DNSSEC stamping', () => {
    it('never queries the unsupported DS rrtype', async () => {
      await resolver.checkAvailability('example.com');
      await resolver.healthCheck();
      for (const call of resolveFn.mock.calls) {
        expect(call[1]).not.toBe('DS');
      }
    });

    it('stamps dnssec=unchecked before healthCheck() has proven validation', async () => {
      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssec).toBe('unchecked');
    });

    it('stamps dnssec=valid on every subsequent lookup once healthCheck() proves validation', async () => {
      resolveFn.mockImplementation((domain) => {
        if (domain === DNSSEC_NEGATIVE_CONTROL) return Promise.reject(dnsError('ESERVFAIL'));
        return Promise.resolve(['1.2.3.4']);
      });
      const health = await resolver.healthCheck();
      expect(health.dnssecValid).toBe(true);

      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssec).toBe('valid');
    });
  });

  describe('healthCheck DNSSEC negative-control probe', () => {
    it('proves validation when the negative control SERVFAILs and the positive control resolves', async () => {
      resolveFn.mockImplementation((domain) => {
        if (domain === DNSSEC_NEGATIVE_CONTROL) return Promise.reject(dnsError('ESERVFAIL'));
        return Promise.resolve(['1.2.3.4']);
      });

      const health = await resolver.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.dnssecValid).toBe(true);
    });

    it('disproves validation when the negative control resolves (val-permissive-mode bypass)', async () => {
      // Every probe resolves, including the deliberately-bogus signature —
      // this is exactly the misconfiguration (val-permissive-mode: yes)
      // this check exists to catch.
      resolveFn.mockImplementation(() => Promise.resolve(['1.2.3.4']));

      const health = await resolver.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.dnssecValid).toBe(false);
    });

    it('falls back to the secondary negative control when the primary zone is unreachable', async () => {
      resolveFn.mockImplementation((domain) => {
        if (domain === DNSSEC_POSITIVE_CONTROL) return Promise.reject(dnsError('ENOTFOUND'));
        if (domain === DNSSEC_NEGATIVE_CONTROL_FALLBACK)
          return Promise.reject(dnsError('ESERVFAIL'));
        return Promise.resolve(['1.2.3.4']);
      });

      const health = await resolver.healthCheck();
      expect(health.dnssecValid).toBe(true);
    });

    it('fails closed (never true) when every probe is inconclusive', async () => {
      resolveFn.mockImplementation((domain) => {
        if (domain === 'cloudflare.com') return Promise.resolve(['1.2.3.4']);
        return Promise.reject(dnsError('ETIMEOUT'));
      });

      const health = await resolver.healthCheck();
      expect(health.dnssecValid).toBe(false);
    });

    it('reports unhealthy when the basic reachability check fails', async () => {
      resolveFn.mockImplementation(() => Promise.reject(dnsError('ETIMEOUT')));

      const health = await resolver.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.dnssecValid).toBe(false);
    });
  });
});

describe('UnboundResolver config validation', () => {
  it('should accept valid unboundHosts', () => {
    const r = new UnboundResolver({ unboundHosts: ['127.0.0.1'] });
    r.dispose();
  });

  it('should accept IPv6 hosts', () => {
    const r = new UnboundResolver({ unboundHosts: ['::1'] });
    r.dispose();
  });

  it('should accept hosts with ports', () => {
    const r = new UnboundResolver({ unboundHosts: ['127.0.0.1:5300', '[::1]:5300'] });
    r.dispose();
  });
});
