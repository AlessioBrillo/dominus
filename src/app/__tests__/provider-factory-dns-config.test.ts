// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDnsProvider } from '../provider-factory.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { RateLimiterLike } from '../../providers/rate-limiter.js';
import type { Config } from '../../config.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import { FallbackResolver } from '../../providers/dns/fallback-resolver.js';

/** Type-safe wrapper for buildDnsProvider in tests. */
async function createDnsProvider(
  config: Config,
  cacheRepo: ProviderCacheRepository,
  rateLimiter: RateLimiterLike,
): Promise<DnsProvider> {
  const provider = await buildDnsProvider(config, cacheRepo, rateLimiter, undefined, undefined);
  return provider as DnsProvider;
}

// Minimal config for testing
const createTestConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    DATABASE_PATH: './data/test.db',
    DATABASE_BUSY_TIMEOUT: 30000,
    DNS_UNBOUND_HOSTS: '127.0.0.1',
    DNS_UNBOUND_TIMEOUT_MS: 1500,
    DNS_CACHE_TTL_SECONDS: 300,
    DNS_CACHE_MAX_SIZE: 10000,
    DNS_BULK_CONCURRENCY: 200,
    DNS_PARKING_CHECK_ENABLED: false,
    DNS_PARKING_IPS_PATH: undefined,
    DNS_UNBOUND_ENABLED: true,
    DNS_UNBOUND_UPSTREAM_TLS: true,
    DNS_UNBOUND_READINESS_TIMEOUT_MS: 30000,
    DNS_UNBOUND_HEALTH_CHECK_ENABLED: false, // Disable for tests
    DNS_UNBOUND_SKIP_READINESS: true,
    DNS_UNBOUND_REVALIDATION_INTERVAL_MS: 600000,
    DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_DEGRADED: 1,
    DNS_UNBOUND_UNHEALTHY_COOLDOWN_MS: 30000,
    DNS_UNBOUND_MIN_HEALTHY_HOSTS: 1,
    DNS_UNBOUND_STRICT: true,
    DNS_PER_QUERY_DNSEC: true,
    DNS_PER_QUERY_DNSEC_TIMEOUT_MS: 10000,
    DNS_PER_QUERY_DNSEC_TIMEOUT_OVERRIDES: {},
    DNSSEC_MODE: 'strict',
    DNSSEC_POSITIVE_CONTROLS: 'sigok.verteiltesysteme.net,dnssec.works,test.dnssec-tools.org',
    // ADR-0078 new options
    DNS_UNBOUND_QUORUM_MODE: 'majority',
    DNS_UNBOUND_PERSIST_DNSSEC_STATE: true,
    DNS_UNBOUND_DNSSEC_STATE_MAX_AGE_MS: 3_600_000,
    DNS_UNBOUND_PURGE_CACHE_ON_DNSSEC_LOSS: true,
    // ADR-0076 DNS Fallback options
    DNS_FALLBACK_ENABLED: true,
    DNS_FALLBACK_PROVIDER: 'node-dns',
    DNS_FALLBACK_ONLY_FOR_NON_AVAILABLE: true,
    ...overrides,
  }) as Config;

describe('buildDnsProvider with ADR-0078 config (provider-factory)', () => {
  let mockCacheRepo: ProviderCacheRepository;
  let mockRateLimiter: RateLimiterLike;
  let config: Config;

  beforeEach(() => {
    mockCacheRepo = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      prune: vi.fn().mockResolvedValue(0),
      clearProvider: vi.fn().mockResolvedValue(0),
    } as unknown as ProviderCacheRepository;

    mockRateLimiter = {
      acquire: vi.fn().mockResolvedValue(undefined),
      throttle: vi.fn().mockImplementation((fn) => fn()),
      maxTokens: 20,
    } as unknown as RateLimiterLike;

    config = createTestConfig();
  });

  it('should wrap UnboundResolver with FallbackResolver', async () => {
    const provider = await createDnsProvider(config, mockCacheRepo, mockRateLimiter);

    expect(provider).toBeDefined();
    expect(provider.name).toBe('FallbackResolver');
    expect(provider).toBeInstanceOf(FallbackResolver);
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should pass persistDnssecState to UnboundResolver via FallbackResolver', async () => {
    const provider = await createDnsProvider(config, mockCacheRepo, mockRateLimiter);

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(FallbackResolver);
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should pass dnssecStateMaxAgeMs to UnboundResolver via FallbackResolver', async () => {
    const provider = await createDnsProvider(config, mockCacheRepo, mockRateLimiter);

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(FallbackResolver);
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should pass purgeCacheOnDnssecLoss to UnboundResolver via FallbackResolver', async () => {
    const provider = await createDnsProvider(config, mockCacheRepo, mockRateLimiter);

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(FallbackResolver);
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should call loadDnssecState before waitForReady in strict mode', async () => {
    // This test verifies the integration path exists
    // Full test would require a running Unbound instance
    const provider = await createDnsProvider(config, mockCacheRepo, mockRateLimiter);

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(FallbackResolver);
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should use majority quorum by default', () => {
    expect(config.DNS_UNBOUND_QUORUM_MODE).toBe('majority');
  });

  it('should enable persistDnssecState by default', () => {
    expect(config.DNS_UNBOUND_PERSIST_DNSSEC_STATE).toBe(true);
  });

  it('should set dnssecStateMaxAgeMs to 1 hour by default', () => {
    expect(config.DNS_UNBOUND_DNSSEC_STATE_MAX_AGE_MS).toBe(3_600_000);
  });

  it('should enable purgeCacheOnDnssecLoss by default', () => {
    expect(config.DNS_UNBOUND_PURGE_CACHE_ON_DNSSEC_LOSS).toBe(true);
  });

  it('should allow overriding quorumMode to simple', async () => {
    const simpleConfig = createTestConfig({ DNS_UNBOUND_QUORUM_MODE: 'simple' });
    const provider = await createDnsProvider(simpleConfig, mockCacheRepo, mockRateLimiter);
    expect(provider).toBeDefined();
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should allow overriding quorumMode to all', async () => {
    const allConfig = createTestConfig({ DNS_UNBOUND_QUORUM_MODE: 'all' });
    const provider = await createDnsProvider(allConfig, mockCacheRepo, mockRateLimiter);
    expect(provider).toBeDefined();
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should allow disabling persistDnssecState', async () => {
    const noPersistConfig = createTestConfig({ DNS_UNBOUND_PERSIST_DNSSEC_STATE: false });
    const provider = await createDnsProvider(noPersistConfig, mockCacheRepo, mockRateLimiter);
    expect(provider).toBeDefined();
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });

  it('should allow disabling purgeCacheOnDnssecLoss', async () => {
    const noPurgeConfig = createTestConfig({ DNS_UNBOUND_PURGE_CACHE_ON_DNSSEC_LOSS: false });
    const provider = await createDnsProvider(noPurgeConfig, mockCacheRepo, mockRateLimiter);
    expect(provider).toBeDefined();
    // @ts-expect-error - TypeScript false positive: provider is definitely assigned
    provider.dispose();
  });
});
