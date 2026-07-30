import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsProvider, buildDnsQuery, validateDnsResponse } from '../node-dns-provider.js';
import { ParkingIpRegistry, type ParkingRange } from '../parking-ip-registry.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { ProviderCacheRepository } from '../../../db/repositories/provider-cache-repository.js';

vi.mock('node:dns', () => {
  const resolveFn = vi.fn();
  return {
    promises: {
      resolve: resolveFn,
    },
  };
});

import { promises as dnsPromises } from 'node:dns';

function makeResolved(): never {
  return ['1.2.3.4'] as never;
}

const PARKING_RANGES: ParkingRange[] = [
  {
    name: 'GoDaddy',
    cidr: ['208.109.0.0/16', '64.202.0.0/16'],
  },
  {
    name: 'TestPark',
    cidr: ['1.2.3.0/24'],
  },
];

describe('NodeDnsProvider', () => {
  let provider: NodeDnsProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new NodeDnsProvider({ cacheTtlMs: 60_000, lookupStrategy: 'native' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns Registered when DNS resolves', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const result = await provider.checkAvailability('taken.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.domain).toBe('taken.com');
  });

  it('returns Available on ENOTFOUND', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('free-domain-xyz-123.com');
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('returns Available on ENODATA', async () => {
    const err = Object.assign(new Error('no data'), { code: 'ENODATA' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('no-records.com');
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('returns Unknown on unexpected error', async () => {
    const err = Object.assign(new Error('network'), { code: 'ETIMEOUT' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('example.com');
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  // Regression: the persistent cache write used to hardcode a 7-day TTL
  // regardless of DNS_PERSISTENT_CACHE_TTL_HOURS. See node-dns-provider.ts #setCaches.
  describe('persistent cache TTL', () => {
    function makeFakePersistentCache(): ProviderCacheRepository {
      return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProviderCacheRepository;
    }

    it('derives ttlDays from persistentCacheTtlHours (24h -> 1 day)', async () => {
      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({
        lookupStrategy: 'native',
        persistentCache,
        persistentCacheTtlHours: 24,
      });
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      await p.checkAvailability('free-domain-xyz-123.com');

      expect(persistentCache.set).toHaveBeenCalledWith(
        'free-domain-xyz-123.com',
        expect.any(String),
        expect.any(String),
        1,
      );
    });

    it('defaults to a 7-day ttlDays when persistentCacheTtlHours is unset', async () => {
      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      await p.checkAvailability('free-domain-xyz-123.com');

      expect(persistentCache.set).toHaveBeenCalledWith(
        'free-domain-xyz-123.com',
        expect.any(String),
        expect.any(String),
        7,
      );
    });
  });

  describe('forceRecheck option', () => {
    function makeFakePersistentCache(): ProviderCacheRepository {
      return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProviderCacheRepository;
    }

    it('reads from persistent cache when forceRecheck is not set', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({
        lookupStrategy: 'native',
        persistentCache,
      });

      // First call: DNS lookup, results cached persistently
      await p.checkAvailability('cached-demo.com');
      expect(persistentCache.set).toHaveBeenCalledTimes(1);

      // Clear in-memory cache so next call must consult persistent cache
      p.clearCache();

      // Reset persistent cache spy — track only the second call
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'cached-demo.com',
          status: DomainStatus.Available,
          checkedAt: new Date().toISOString(),
        }),
      );

      // Second call without forceRecheck: should hit persistent cache
      const result = await p.checkAvailability('cached-demo.com');
      expect(result.status).toBe(DomainStatus.Available);
      expect(persistentCache.get).toHaveBeenCalledWith('cached-demo.com', expect.any(String));
    });

    it('skips persistent cache when forceRecheck is true, forcing live DNS', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({
        lookupStrategy: 'native',
        persistentCache,
      });

      // First call: DNS lookup, cached persistently
      await p.checkAvailability('stale-cached.com');
      expect(persistentCache.set).toHaveBeenCalledTimes(1);

      // Reset persistent cache spy for second call
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'stale-cached.com',
          status: DomainStatus.Registered,
          checkedAt: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      );

      // Clear in-memory cache so provider must choose persistent cache vs live DNS
      p.clearCache();
      vi.mocked(dnsPromises.resolve).mockClear();
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      // Second call with forceRecheck: MUST bypass persistent cache
      const result = await p.checkAvailability('stale-cached.com', undefined, {
        forceRecheck: true,
      });
      expect(result.status).toBe(DomainStatus.Available);
      expect(persistentCache.get).not.toHaveBeenCalled();
    });
  });

  it('checkBulk returns results for all domains', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const results = await provider.checkBulk(['a.com', 'b.com', 'c.com']);
    expect(results).toHaveLength(3);
  });

  it('returns cached result on repeated check without DNS lookup', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('cached.com');

    vi.mocked(dnsPromises.resolve).mockClear();

    const result = await provider.checkAvailability('cached.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(dnsPromises.resolve).not.toHaveBeenCalled();
  });

  it('expires cache entry after TTL and performs fresh lookup', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('expire.com');

    vi.advanceTimersByTime(60_001);
    vi.mocked(dnsPromises.resolve).mockClear();

    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const result = await provider.checkAvailability('expire.com');
    expect(dnsPromises.resolve).toHaveBeenCalled();
    expect(result.status).toBe(DomainStatus.Registered);
  });

  it('pruneCache removes expired entries', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('stale.com');

    vi.advanceTimersByTime(60_001);
    const pruned = provider.pruneCache();

    expect(pruned).toBe(1);
  });

  it('clearCache removes all entries', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('clear.com');

    vi.mocked(dnsPromises.resolve).mockClear();

    provider.clearCache();
    await provider.checkAvailability('clear.com');
    expect(dnsPromises.resolve).toHaveBeenCalled();
  });

  it('configures resolver groups from constructor', () => {
    const nsProvider = new NodeDnsProvider({
      resolverGroups: [
        {
          name: 'test',
          lookups: [{ type: 'native' }, { type: 'doh', endpoint: 'https://dns.google/dns-query' }],
        },
      ],
    });
    expect(nsProvider).toBeDefined();
  });

  it('checkAvailability rejects when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(provider.checkAvailability('aborted.com', ac.signal)).rejects.toThrow('Aborted');
  });

  it('returns isParked=true when domain resolves to a known parking IP', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      lookupStrategy: 'native',
      parkingEnabled: true,
      parkingRegistry,
    });
    const result = await p.checkAvailability('parked.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBe(true);
    expect(result.parkingRegistrar).toBe('TestPark');
  });

  it('does not set isParked when parking is disabled', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      lookupStrategy: 'native',
      parkingEnabled: false,
      parkingRegistry,
    });
    const result = await p.checkAvailability('parked.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBeUndefined();
  });

  it('returns isParked=false when domain resolves but IP is not a parking range', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(['9.9.9.9'] as never);
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      lookupStrategy: 'native',
      parkingEnabled: true,
      parkingRegistry,
    });
    const result = await p.checkAvailability('active-site.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBeUndefined();
  });

  describe('doh-only strategy', () => {
    let dohProvider: NodeDnsProvider;

    beforeEach(() => {
      dohProvider = new NodeDnsProvider({ lookupStrategy: 'doh-only', cacheTtlMs: 60_000 });
      vi.clearAllMocks();
    });

    function mockFetchResponse(
      status: number,
      answer?: Array<{ type: number; data: string }>,
    ): void {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Status: status, Answer: answer }),
      } as Response);
    }

    it('returns Registered when DoH Phase 1 resolves', async () => {
      mockFetchResponse(0, [{ type: 1, data: '1.2.3.4' }]);
      const result = await dohProvider.checkAvailability('taken-doh.com');
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('returns Available on DoH NXDOMAIN', async () => {
      mockFetchResponse(3);
      const result = await dohProvider.checkAvailability('free-doh.com');
      expect(result.status).toBe(DomainStatus.Available);
    });

    it('returns Unknown when all DoH resolvers fail', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
      const result = await dohProvider.checkAvailability('fail-doh.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });
  });

  describe('buildDnsQuery', () => {
    it('produces different query IDs on successive calls', () => {
      const q1 = buildDnsQuery('example.com', 1);
      const q2 = buildDnsQuery('example.com', 1);
      const id1 = q1.readUInt16BE(0);
      const id2 = q2.readUInt16BE(0);
      // Probability of collision: 1/65536 per pair — acceptable false-fail rate
      expect(id1).not.toBe(id2);
    });
  });

  describe('validateDnsResponse', () => {
    it('accepts response with matching query ID', () => {
      const query = buildDnsQuery('example.com', 1);
      const expectedId = query.readUInt16BE(0);
      // Simulate a valid response header with matching ID
      const resp = Buffer.alloc(12);
      resp.writeUInt16BE(expectedId, 0);
      resp.writeUInt16BE(0x8180, 2); // QR=1, RCODE=0
      expect(validateDnsResponse(resp, expectedId)).toBe(true);
    });

    it('rejects response with mismatched query ID', () => {
      const resp = Buffer.alloc(12);
      resp.writeUInt16BE(0x1234, 0);
      expect(validateDnsResponse(resp, 0xabcd)).toBe(false);
    });

    it('rejects response shorter than DNS header', () => {
      const resp = Buffer.alloc(10);
      expect(validateDnsResponse(resp, 0x1234)).toBe(false);
    });
  });
});
