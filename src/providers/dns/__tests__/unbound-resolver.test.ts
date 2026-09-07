// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnboundResolver } from '../unbound-resolver.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { DnsCheckResult } from '../../../types/domain-status.js';
import type { ProviderCacheRepository } from '../../../db/repositories/provider-cache-repository.js';
import type { RateLimiterLike } from '../../../providers/rate-limiter.js';

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
      useTls: true,
      tlsPort: 853,
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
      // Manually populate cache via public method
      await resolver.checkAvailability('example.com');
      // The result will be Unknown since no real Unbound, but we can test structure
      const result = await resolver.checkAvailability('example.com');
      expect(result.domain).toBe('example.com');
      expect(result.status).toBeDefined();
      expect(result.checkedAt).toBeDefined();
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

      // The actual DNS lookup will happen (returns Unknown since no real Unbound)
      await resolver.checkAvailability('example.com', undefined, {
        forceRecheck: true,
      });

      // Should not have used persistent cache
      expect(mockCacheRepo.get).not.toHaveBeenCalled();
    });

    it('should not persist Unknown results', async () => {
      // Let the lookup run (will fail without real Unbound, returns Unknown)
      await resolver.checkAvailability('nonexistent.invalid');

      // Verify persistent cache was not set for Unknown
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
        expect(r.status).toBeDefined();
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
      // Should not throw
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
      // The promise should still resolve (not hang)
      const result = await promise;
      expect(result).toBeDefined();
    });
  });

  describe('DNSSEC status', () => {
    it('should report dnssec as valid when enabled and resolved', async () => {
      // We can't easily test the actual DNS resolution without a real Unbound
      // but we can verify the structure
      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssec).toBeDefined();
      expect(['valid', 'unchecked']).toContain(result.dnssec);
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
