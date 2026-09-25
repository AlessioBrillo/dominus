// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsFallback } from '../node-dns-fallback.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { ProviderCacheRepository } from '../../../db/repositories/provider-cache-repository.js';
import type { RateLimiterLike } from '../../../providers/rate-limiter.js';
import type { Resolver as NodeResolver } from 'node:dns';

const mockRateLimiter = {
  acquire: vi.fn(),
  maxTokens: 100,
  throttle: vi.fn(),
} as unknown as RateLimiterLike;

const mockPersistentCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  mockResolvedValue: vi.fn(),
  mockResolvedValueOnce: vi.fn(),
  mockClear: vi.fn(),
} as unknown as ProviderCacheRepository & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  mockResolvedValue: ReturnType<typeof vi.fn>;
  mockResolvedValueOnce: ReturnType<typeof vi.fn>;
  mockClear: ReturnType<typeof vi.fn>;
};

describe('NodeDnsFallback', () => {
  let provider: NodeDnsFallback;
  let testResolver: NodeResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockPersistentCache.get.mockResolvedValue(null);
    mockPersistentCache.set.mockResolvedValue(undefined);
    mockPersistentCache.set.mockClear();
    // @ts-expect-error - mock method for testing
    mockRateLimiter.acquire.mockResolvedValue(undefined);

    testResolver = { resolve: vi.fn(), cancel: vi.fn() } as unknown as NodeResolver;

    provider = new NodeDnsFallback({
      lookupTimeoutMs: 100,
      cacheTtlMs: 0,
      maxSize: 100,
      rateLimiter: mockRateLimiter,
      persistentCache: mockPersistentCache,
      persistentCacheTtlHours: 168,
      persistentAvailableStaleMs: 24 * 60 * 60_000,
      testResolver: testResolver,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    provider.dispose();
  });

  function setMockResolver(
    impl: (
      domain: string,
      type: string,
      cb: (err: Error | null, addresses: string[] | undefined) => void,
    ) => void,
  ): void {
    (testResolver.resolve as unknown as ReturnType<typeof vi.fn>).mockImplementation(impl);
  }

  it('should return Available for NXDOMAIN', async () => {
    setMockResolver((_domain, _type, cb) => {
      const err = new Error('ENOTFOUND') as Error & { code: string };
      err.code = 'ENOTFOUND';
      cb(err, undefined);
    });

    const result = await provider.checkAvailability('available.example.com');

    expect(result.status).toBe(DomainStatus.Available);
    expect(result.dnssec).toBe('unchecked');
    expect(result.domain).toBe('available.example.com');
  });

  it('should return Registered for successful A record', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['93.184.216.34']));

    const result = await provider.checkAvailability('registered.example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.dnssec).toBe('unchecked');
  });

  it('should return Unknown on timeout', async () => {
    setMockResolver((_domain, _type, cb) => {
      const err = new Error('ETIMEOUT') as Error & { code: string };
      err.code = 'ETIMEOUT';
      cb(err, undefined);
    });

    const result = await provider.checkAvailability('timeout.example.com');

    expect(result.status).toBe(DomainStatus.Unknown);
    expect(result.dnssec).toBe('unchecked');
  });

  it('should return Unknown on other errors', async () => {
    setMockResolver((_domain, _type, cb) => {
      const err = new Error('SERVFAIL') as Error & { code: string };
      err.code = 'SERVFAIL';
      cb(err, undefined);
    });

    const result = await provider.checkAvailability('error.example.com');

    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('should cache results in memory', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    await provider.checkAvailability('cached.example.com');
    await provider.checkAvailability('cached.example.com');

    expect(testResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('should respect forceRecheck option by skipping persistent cache', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    await provider.checkAvailability('force.example.com');
    provider.clearCache();
    await provider.checkAvailability('force.example.com', undefined, { forceRecheck: true });

    expect(testResolver.resolve).toHaveBeenCalledTimes(2);
  });

  it('should return cached persistent result when available and not stale', async () => {
    const cachedResult = {
      domain: 'persistent.example.com',
      status: DomainStatus.Registered,
      checkedAt: new Date().toISOString(),
      dnssec: 'unchecked',
    };

    mockPersistentCache.get.mockResolvedValueOnce(JSON.stringify(cachedResult));

    const result = await provider.checkAvailability('persistent.example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.fromCache).toBe(true);
    expect(mockPersistentCache.get).toHaveBeenCalled();
  });

  it('should skip persistent cache for stale Available results', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const cachedResult = {
      domain: 'stale.example.com',
      status: DomainStatus.Available,
      checkedAt: staleDate,
      dnssec: 'unchecked',
    };

    mockPersistentCache.get.mockResolvedValueOnce(JSON.stringify(cachedResult));
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    const result = await provider.checkAvailability('stale.example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(testResolver.resolve).toHaveBeenCalled();
  });

  it('should skip persistent cache for stale Unknown results', async () => {
    const staleDate = new Date(Date.now() - 20 * 60_000).toISOString();
    const cachedResult = {
      domain: 'unknown.example.com',
      status: DomainStatus.Unknown,
      checkedAt: staleDate,
      dnssec: 'unchecked',
    };

    mockPersistentCache.get.mockResolvedValueOnce(JSON.stringify(cachedResult));
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    const result = await provider.checkAvailability('unknown.example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(testResolver.resolve).toHaveBeenCalled();
  });

  it('should handle corrupted persistent cache gracefully', async () => {
    mockPersistentCache.get.mockResolvedValueOnce('invalid json');
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    const result = await provider.checkAvailability('corrupted.example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(testResolver.resolve).toHaveBeenCalled();
  });

  it('should coalesce concurrent requests for same domain', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    const promise1 = provider.checkAvailability('coalesce.example.com');
    const promise2 = provider.checkAvailability('coalesce.example.com');

    await vi.advanceTimersByTimeAsync(10);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.status).toBe(DomainStatus.Registered);
    expect(result2.status).toBe(DomainStatus.Registered);
    expect(testResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('should throw AbortError when aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.checkAvailability('aborted.example.com', controller.signal),
    ).rejects.toThrow('Aborted');
  });

  it('should handle bulk checks', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    const domains = ['bulk1.example.com', 'bulk2.example.com', 'bulk3.example.com'];
    const results = await provider.checkBulk(domains);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === DomainStatus.Registered)).toBe(true);
  });

  it('should handle bulk checks with signal abort', async () => {
    setMockResolver((_domain, _type, _cb) => {});

    const controller = new AbortController();
    const domains = ['abort1.example.com', 'abort2.example.com'];

    controller.abort();

    await expect(provider.checkBulk(domains, controller.signal)).rejects.toThrow();
  });

  it('should prune cache', () => {
    expect(provider.pruneCache()).toBe(0);
  });

  it('should clear cache', () => {
    provider.clearCache();
    expect(provider.pruneCache()).toBe(0);
  });

  it('should dispose cleanly', () => {
    expect(() => provider.dispose()).not.toThrow();
  });

  it('should not persist Unknown results', async () => {
    setMockResolver((_domain, _type, cb) => {
      const err = new Error('ETIMEOUT') as Error & { code: string };
      err.code = 'ETIMEOUT';
      cb(err, undefined);
    });

    await provider.checkAvailability('unknown-persist.example.com');

    expect(mockPersistentCache.set).not.toHaveBeenCalled();
  });

  it('should persist Registered and Available results', async () => {
    setMockResolver((_domain, _type, cb) => cb(null, ['1.2.3.4']));

    await provider.checkAvailability('persist-registered.example.com');

    expect(mockPersistentCache.set).toHaveBeenCalledWith(
      'persist-registered.example.com',
      'NodeDnsFallback',
      expect.any(String),
      168 / 24,
    );
  });

  it('should record metrics when callback provided', async () => {
    const metricsCallback = vi.fn();
    const metricsTestResolver = { resolve: vi.fn(), cancel: vi.fn() } as unknown as NodeResolver;
    const metricsProvider = new NodeDnsFallback({
      lookupTimeoutMs: 100,
      cacheTtlMs: 0,
      maxSize: 100,
      rateLimiter: mockRateLimiter,
      testResolver: metricsTestResolver,
      onResolution: metricsCallback,
    });
    // @ts-expect-error - mock method for testing
    metricsTestResolver.resolve.mockImplementation(
      (
        _domain: string,
        _type: string,
        cb: (err: Error | null, addresses: string[] | undefined) => void,
      ) => cb(null, ['1.2.3.4']),
    );

    await metricsProvider.checkAvailability('metrics.example.com');

    expect(metricsCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: expect.any(Number),
        status: 'registered',
        dnssec: 'unchecked',
        fromCache: false,
      }),
    );

    metricsProvider.dispose();
  });
});
