// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomainStatus } from '../../../types/domain-status.js';
import { FallbackResolver, createFallbackProvider } from '../fallback-resolver.js';
import type { DnsCheckResult } from '../dns-provider.js';

function createMockPrimary(overrides: Record<string, unknown> = {}): {
  name: string;
  isHealthy: ReturnType<typeof vi.fn>;
  getHealthStatus: ReturnType<typeof vi.fn>;
  checkAvailability: ReturnType<typeof vi.fn>;
  checkBulk: ReturnType<typeof vi.fn>;
  pruneCache: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const checkAvailability = vi.fn(async (domain: string): Promise<DnsCheckResult> => ({
    domain,
    status: DomainStatus.Registered,
    checkedAt: new Date().toISOString(),
    isParked: false,
    dnssec: 'valid' as const,
    dnssecSource: 'resolver-level' as const,
    durationMs: 10,
    fromCache: false,
  }));

  const checkBulk = vi.fn(async (domains: string[]): Promise<DnsCheckResult[]> =>
    domains.map((domain) => ({
      domain,
      status: DomainStatus.Registered,
      checkedAt: new Date().toISOString(),
      isParked: false,
      dnssec: 'valid' as const,
      dnssecSource: 'resolver-level' as const,
      durationMs: 10,
      fromCache: false,
    })),
  );

  return {
    name: 'UnboundResolver',
    isHealthy: vi.fn(() => true),
    getHealthStatus: vi.fn(() => ({
      healthy: true,
      dnssecValid: true,
      quorumMet: true,
      hosts: [],
    })),
    checkAvailability,
    checkBulk,
    pruneCache: vi.fn(() => 0),
    clearCache: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function createMockFallback(overrides: Record<string, unknown> = {}): {
  name: string;
  checkAvailability: ReturnType<typeof vi.fn>;
  checkBulk: ReturnType<typeof vi.fn>;
  pruneCache: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const checkAvailability = vi.fn(async (domain: string): Promise<DnsCheckResult> => ({
    domain,
    status: DomainStatus.Registered,
    checkedAt: new Date().toISOString(),
    isParked: false,
    dnssec: 'unchecked' as const,
    dnssecSource: 'unchecked' as const,
    durationMs: 50,
    fromCache: false,
  }));

  const checkBulk = vi.fn(async (domains: string[]): Promise<DnsCheckResult[]> =>
    domains.map((domain) => ({
      domain,
      status: DomainStatus.Registered,
      checkedAt: new Date().toISOString(),
      isParked: false,
      dnssec: 'unchecked' as const,
      dnssecSource: 'unchecked' as const,
      durationMs: 50,
      fromCache: false,
    })),
  );

  return {
    name: 'NodeDnsFallback',
    checkAvailability,
    checkBulk,
    pruneCache: vi.fn(() => 0),
    clearCache: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('FallbackResolver', () => {
  let mockPrimary: ReturnType<typeof createMockPrimary>;
  let mockFallback: ReturnType<typeof createMockFallback>;
  let resolver: FallbackResolver;
  let onFallbackActive: (active: boolean, reason: string) => void;

  beforeEach(() => {
    mockPrimary = createMockPrimary();
    mockFallback = createMockFallback();
    onFallbackActive = vi.fn();

    resolver = new FallbackResolver({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      primary: mockPrimary as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fallback: mockFallback as any,
      enabled: true,
      onlyForNonAvailable: true,
      onFallbackActive,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Primary healthy — returns primary results', () => {
    it('returns primary result when primary is healthy', async () => {
      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssecSource).toBe('resolver-level');
      expect(onFallbackActive).toHaveBeenCalledWith(false, 'primary healthy');
    });

    it('returns primary bulk results when primary is healthy', async () => {
      const results = await resolver.checkBulk(['example.com', 'test.com']);
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.dnssecSource).toBe('resolver-level');
      expect(results[1]!.dnssecSource).toBe('resolver-level');
      expect(onFallbackActive).toHaveBeenCalledWith(false, 'primary healthy');
    });
  });

  describe('Primary unhealthy — fallback for non-Available verdicts', () => {
    it('uses fallback when primary unhealthy and returns Registered', async () => {
      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssecSource).toBe('unchecked');
      expect(onFallbackActive).toHaveBeenCalledWith(true, 'primary unhealthy');
      expect(mockFallback.checkAvailability).toHaveBeenCalledWith(
        'example.com',
        undefined,
        undefined,
      );
    });

    it('uses fallback when primary unhealthy and returns Unknown', async () => {
      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssecSource).toBe('unchecked');
      expect(onFallbackActive).toHaveBeenCalledWith(true, 'primary unhealthy');
    });

    it('BLOCKS fallback for Available verdict — returns Unknown (SAFETY GATE)', async () => {
      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'available-domain.com',
        status: DomainStatus.Available,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('available-domain.com');
      expect(result.status).toBe(DomainStatus.Unknown);
      expect(result.dnssecSource).toBe('unchecked');
      expect(mockFallback.checkAvailability).not.toHaveBeenCalled();
      expect(onFallbackActive).toHaveBeenCalledWith(
        true,
        'primary unhealthy — Available verdict blocked from fallback',
      );
    });

    it('BLOCKS fallback for Available verdict in bulk — returns Unknown for those domains', async () => {
      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkBulk.mockResolvedValue([
        {
          domain: 'available.com',
          status: DomainStatus.Available,
          checkedAt: new Date().toISOString(),
          isParked: false,
          dnssec: 'valid',
          dnssecSource: 'resolver-level',
          durationMs: 10,
          fromCache: false,
        },
        {
          domain: 'registered.com',
          status: DomainStatus.Registered,
          checkedAt: new Date().toISOString(),
          isParked: false,
          dnssec: 'valid',
          dnssecSource: 'resolver-level',
          durationMs: 10,
          fromCache: false,
        },
      ]);

      const results = await resolver.checkBulk(['available.com', 'registered.com']);
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.status).toBe(DomainStatus.Unknown);
      expect(results[0]!.dnssecSource).toBe('unchecked');
      expect(results[1]!.dnssecSource).toBe('unchecked');
      expect(mockFallback.checkBulk).toHaveBeenCalledWith(['registered.com'], undefined, undefined);
    });
  });

  describe('Primary failed (throws) — fallback for non-Available', () => {
    it('uses fallback when primary throws', async () => {
      mockPrimary.checkAvailability.mockRejectedValue(new Error('Primary down'));
      mockPrimary.isHealthy.mockReturnValue(false); // Primary is unhealthy when it throws

      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssecSource).toBe('unchecked');
      expect(onFallbackActive).toHaveBeenCalledWith(true, 'primary failed');
    });

    it('blocks fallback for Available when primary throws', async () => {
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'available.com',
        status: DomainStatus.Available,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });
      mockPrimary.isHealthy.mockReturnValue(false);

      const result = await resolver.checkAvailability('available.com');
      expect(result.status).toBe(DomainStatus.Unknown);
      expect(result.dnssecSource).toBe('unchecked');
    });
  });

  describe('Fallback rate limiting', () => {
    it('respects fallback rate limiter — returns Unknown when rate limited', async () => {
      const rateLimiter = {
        acquire: vi.fn().mockRejectedValue(new Error('Rate limited')),
      };

      resolver = new FallbackResolver({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primary: mockPrimary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fallback: mockFallback as any,
        enabled: true,
        onlyForNonAvailable: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fallbackRateLimiter: rateLimiter as any,
        onFallbackActive,
      });

      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('example.com');
      expect(result.status).toBe(DomainStatus.Unknown);
      expect(result.dnssecSource).toBe('unchecked');
      expect(rateLimiter.acquire).toHaveBeenCalled();
    });
  });

  describe('Disabled fallback', () => {
    it('never uses fallback when disabled', async () => {
      resolver = new FallbackResolver({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primary: mockPrimary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fallback: mockFallback as any,
        enabled: false,
        onFallbackActive,
      });

      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('example.com');
      expect(result.dnssecSource).toBe('resolver-level'); // Still returns primary result even if unhealthy
      expect(mockFallback.checkAvailability).not.toHaveBeenCalled();
      expect(onFallbackActive).not.toHaveBeenCalled();
    });
  });

  describe('onlyForNonAvailable = false (dangerous, for testing only)', () => {
    it('allows fallback for Available when gate disabled', async () => {
      resolver = new FallbackResolver({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primary: mockPrimary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fallback: mockFallback as any,
        enabled: true,
        onlyForNonAvailable: false, // DANGEROUS: allows fallback for Available
        onFallbackActive,
      });

      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'available.com',
        status: DomainStatus.Available,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      const result = await resolver.checkAvailability('available.com');
      expect(result.dnssecSource).toBe('unchecked');
      expect(result.status).toBe(DomainStatus.Registered); // Fallback returns Registered
      expect(mockFallback.checkAvailability).toHaveBeenCalled();
    });
  });

  describe('getFallbackStatus', () => {
    it('returns correct status when primary healthy', () => {
      mockPrimary.isHealthy.mockReturnValue(true);
      const status = resolver.getFallbackStatus();
      expect(status.active).toBe(false);
      expect(status.primaryHealthy).toBe(true);
    });

    it('returns correct status when fallback active', async () => {
      mockPrimary.isHealthy.mockReturnValue(false);
      mockPrimary.checkAvailability.mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid',
        dnssecSource: 'resolver-level',
        durationMs: 10,
        fromCache: false,
      });

      await resolver.checkAvailability('example.com');
      const status = resolver.getFallbackStatus();
      expect(status.active).toBe(true);
      expect(status.primaryHealthy).toBe(false);
      expect(status.reason).toBe('primary unhealthy');
    });
  });

  describe('Cache delegation', () => {
    it('delegates pruneCache to primary', () => {
      mockPrimary.pruneCache.mockReturnValue(5);
      expect(resolver.pruneCache()).toBe(5);
      expect(mockPrimary.pruneCache).toHaveBeenCalled();
    });

    it('delegates clearCache to both primary and fallback', () => {
      resolver.clearCache();
      expect(mockPrimary.clearCache).toHaveBeenCalled();
      expect(mockFallback.clearCache).toHaveBeenCalled();
    });

    it('delegates dispose to both primary and fallback', () => {
      resolver.dispose();
      expect(mockPrimary.dispose).toHaveBeenCalled();
      expect(mockFallback.dispose).toHaveBeenCalled();
    });
  });
});

describe('createFallbackProvider', () => {
  it('creates node-dns fallback', async () => {
    const provider = await createFallbackProvider('node-dns');
    expect(provider).toBeDefined();
    expect(typeof provider.checkAvailability).toBe('function');
    expect(typeof provider.checkBulk).toBe('function');
    provider.dispose?.();
  });

  it('fails closed for cloudflare-doh (not implemented)', async () => {
    await expect(createFallbackProvider('cloudflare-doh')).rejects.toThrow(
      "'cloudflare-doh' is not implemented",
    );
  });

  it('fails closed for google-doh (not implemented)', async () => {
    await expect(createFallbackProvider('google-doh')).rejects.toThrow(
      "'google-doh' is not implemented",
    );
  });

  it('throws for unknown type', async () => {
    await expect(
      createFallbackProvider('unknown' as 'node-dns' | 'cloudflare-doh' | 'google-doh'),
    ).rejects.toThrow('Unknown fallback provider type');
  });

  it('resolves duplicate domains independently in bulk (index-based merge)', async () => {
    const primary = createMockPrimary();
    primary.isHealthy.mockReturnValue(false);
    primary.checkBulk.mockResolvedValue([
      {
        domain: 'dup.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid' as const,
        dnssecSource: 'resolver-level' as const,
        durationMs: 10,
        fromCache: false,
      },
      {
        domain: 'dup.com',
        status: DomainStatus.Registered,
        checkedAt: new Date().toISOString(),
        isParked: false,
        dnssec: 'valid' as const,
        dnssecSource: 'resolver-level' as const,
        durationMs: 10,
        fromCache: false,
      },
    ]);
    const fallback = createMockFallback();
    const resolver = new FallbackResolver({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      primary: primary as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fallback: fallback as any,
      enabled: true,
      onlyForNonAvailable: true,
    });

    const results = await resolver.checkBulk(['dup.com', 'dup.com']);
    expect(results).toHaveLength(2);
    expect(results[0]!.domain).toBe('dup.com');
    expect(results[1]!.domain).toBe('dup.com');
    expect(fallback.checkBulk).toHaveBeenCalledWith(['dup.com', 'dup.com'], undefined, undefined);
  });
});
