// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsProvider, buildDnsQuery, validateDnsResponse } from '../node-dns-provider.js';
import { strategyToResolverGroups } from '../dns-provider.js';
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

  describe('cache disable semantics', () => {
    it('maxSize 0 disables the in-memory cache — every call does a live lookup', async () => {
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      const p = new NodeDnsProvider({ lookupStrategy: 'native', cacheTtlMs: 60_000, maxSize: 0 });

      await p.checkAvailability('no-cache.com');
      await p.checkAvailability('no-cache.com');
      await p.checkAvailability('no-cache.com');

      expect(dnsPromises.resolve).toHaveBeenCalledTimes(3);
    });

    it('cacheTtlMs 0 keeps the cache enabled without TTL expiry', async () => {
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      const p = new NodeDnsProvider({ lookupStrategy: 'native', cacheTtlMs: 0, maxSize: 100 });

      await p.checkAvailability('no-ttl.com');
      const result = await p.checkAvailability('no-ttl.com');

      expect(dnsPromises.resolve).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(DomainStatus.Registered);
    });
  });

  describe('Unknown persistence guard', () => {
    function makeFakePersistentCache(): ProviderCacheRepository {
      return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProviderCacheRepository;
    }

    it('never persists an Unknown result to the persistent cache', async () => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('unknown-not-persisted.com');

      expect(result.status).toBe(DomainStatus.Unknown);
      expect(persistentCache.set).not.toHaveBeenCalled();
    });

    it('still persists definitive results', async () => {
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      const persistentCache = makeFakePersistentCache();
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      await p.checkAvailability('definitive-persisted.com');

      expect(persistentCache.set).toHaveBeenCalledTimes(1);
    });

    it('re-checks live a stale Unknown row from the persistent cache', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'stale-unknown.com',
          status: DomainStatus.Unknown,
          checkedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        }),
      );
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('stale-unknown.com');

      expect(dnsPromises.resolve).toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('serves a fresh Unknown row from the persistent cache without a live lookup', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'fresh-unknown.com',
          status: DomainStatus.Unknown,
          checkedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('fresh-unknown.com');

      expect(dnsPromises.resolve).not.toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Unknown);
    });
  });

  describe('Available staleness guard', () => {
    function makeFakePersistentCache(): ProviderCacheRepository {
      return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProviderCacheRepository;
    }

    it('serves a fresh Available row from the persistent cache without a live lookup', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'fresh-available.com',
          status: DomainStatus.Available,
          checkedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('fresh-available.com');

      expect(dnsPromises.resolve).not.toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Available);
    });

    it('re-checks live an Available row older than the default 24h stale window', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'stale-available.com',
          status: DomainStatus.Available,
          checkedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        }),
      );
      // Live DNS now says the domain is taken — the stale "Available" must not win.
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('stale-available.com');

      expect(dnsPromises.resolve).toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('serves a stale Registered row without a live lookup', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'stale-registered.com',
          status: DomainStatus.Registered,
          checkedAt: new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString(),
        }),
      );
      const p = new NodeDnsProvider({ lookupStrategy: 'native', persistentCache });

      const result = await p.checkAvailability('stale-registered.com');

      expect(dnsPromises.resolve).not.toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('re-checks Available rows older than a custom stale window', async () => {
      const persistentCache = makeFakePersistentCache();
      persistentCache.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          domain: 'custom-window.com',
          status: DomainStatus.Available,
          checkedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        }),
      );
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
      const p = new NodeDnsProvider({
        lookupStrategy: 'native',
        persistentCache,
        persistentAvailableStaleMs: 60 * 60_000,
      });

      const result = await p.checkAvailability('custom-window.com');

      expect(dnsPromises.resolve).toHaveBeenCalled();
      expect(result.status).toBe(DomainStatus.Available);
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

  it('keeps the Registered verdict when the parking probe is aborted', async () => {
    // Main A lookup resolves; the parking A/AAAA probes never settle, so the
    // caller's abort must cut them short instead of hanging the check.
    vi.mocked(dnsPromises.resolve)
      .mockResolvedValueOnce(makeResolved())
      .mockReturnValue(new Promise(() => {}) as never);
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      lookupStrategy: 'native',
      parkingEnabled: true,
      parkingRegistry,
      lookupTimeoutMs: 5000,
    });
    const ac = new AbortController();
    const resultPromise = p.checkAvailability('parking-hang.com', ac.signal);
    await vi.waitFor(() => expect(vi.mocked(dnsPromises.resolve)).toHaveBeenCalledTimes(3));
    ac.abort();
    const result = await resultPromise;
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

  describe('doh-primary strategy', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('produces a multi-DoH group with a native fallback group', () => {
      const groups = strategyToResolverGroups(
        'doh-primary',
        'https://cloudflare-dns.com/dns-query',
      );
      expect(groups).toHaveLength(2);
      expect(groups[0]?.name).toBe('multi-doh');
      expect(groups[0]?.lookups.every((l) => l.type === 'doh')).toBe(true);
      expect(groups[1]?.name).toBe('multi-doh-native-fallback');
      expect(groups[1]?.lookups.map((l) => l.type)).toEqual(['native']);
    });

    it('falls back to the native resolver when every DoH lookup fails', async () => {
      // Regression: 'doh-primary' was silently identical to 'doh-only',
      // so a DoH outage produced Unknown even when the system resolver
      // could answer — the default install never had a native fallback.
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('DoH network error'));
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());

      const p = new NodeDnsProvider({ lookupStrategy: 'doh-primary', cacheTtlMs: 60_000 });
      const result = await p.checkAvailability('fallback-works.com');
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('does not consult native when DoH is definitive (NXDOMAIN)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Status: 3 }),
      } as Response);

      const p = new NodeDnsProvider({ lookupStrategy: 'doh-primary', cacheTtlMs: 60_000 });
      const result = await p.checkAvailability('definitive-nxdomain.com');
      expect(result.status).toBe(DomainStatus.Available);
      expect(dnsPromises.resolve).not.toHaveBeenCalled();
    });

    it('returns Unknown when DoH fails and native cannot confirm', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('DoH network error'));
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);

      const p = new NodeDnsProvider({ lookupStrategy: 'doh-primary', cacheTtlMs: 60_000 });
      const result = await p.checkAvailability('both-fail.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });
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

  describe('conservative resolver-group decisions', () => {
    function makeMixedGroupProvider(): NodeDnsProvider {
      return new NodeDnsProvider({
        cacheTtlMs: 60_000,
        resolverGroups: [
          {
            name: 'mixed',
            lookups: [
              { type: 'native' },
              { type: 'doh', endpoint: 'https://dns.google/dns-query' },
            ],
          },
        ],
      });
    }

    it('treats a group with one NXDOMAIN and one failed lookup as Unknown (not Available)', async () => {
      // Regression: the group returned false (single NXDOMAIN) whenever any
      // lookup was definitive, letting a resolver that timed out be
      // outvoted — a false "Available" on a domain another resolver could
      // not confirm. Unknown must win over NXDOMAIN (ADR-0002 conservatism).
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const p = makeMixedGroupProvider();
      const result = await p.checkAvailability('mixed-opinion.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('keeps Available when every lookup in the group agrees on NXDOMAIN', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Status: 3 }),
      } as Response);

      const p = makeMixedGroupProvider();
      const result = await p.checkAvailability('all-agree-free.com');
      expect(result.status).toBe(DomainStatus.Available);
    });

    it('keeps Registered when one lookup resolves and another fails', async () => {
      vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const p = makeMixedGroupProvider();
      const result = await p.checkAvailability('some-resolve.com');
      expect(result.status).toBe(DomainStatus.Registered);
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

    it('uses the injected RNG for the query ID', () => {
      const rng = (size: number): Buffer => {
        const b = Buffer.alloc(size);
        b.writeUInt16BE(0xabcd, 0);
        return b;
      };
      const q = buildDnsQuery('example.com', 1, rng);
      expect(q.readUInt16BE(0)).toBe(0xabcd);
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

  describe('dispose', () => {
    it('is idempotent and safe when no DoT pools were created', () => {
      const p = new NodeDnsProvider({ lookupStrategy: 'native' });
      expect(() => p.dispose()).not.toThrow();
      expect(() => p.dispose()).not.toThrow();
    });

    it('rejects pending lookups and stays usable after dispose', async () => {
      vi.mocked(dnsPromises.resolve).mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
      );
      const p = new NodeDnsProvider({ lookupStrategy: 'native' });
      const pending = p.checkAvailability('dispose-pending.com');
      p.dispose();
      const result = await pending;
      expect(result.status).toBe(DomainStatus.Unknown);
      const again = await p.checkAvailability('dispose-pending.com');
      expect(again.status).toBe(DomainStatus.Unknown);
    });
  });
});
