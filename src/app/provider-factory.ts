import type { Config } from '../config.js';
import type { ProviderCacheRepository } from '../db/index.js';
import {
  createKeywordProvider,
  type KeywordProvider,
  type KeywordMetrics,
} from '../providers/keyword/index.js';
import { createCompsProvider, type CompsProvider } from '../providers/comps/index.js';
import type { ComparableSale } from '../providers/comps/comps-provider.js';
import { CachedProvider } from '../providers/cached-provider.js';
import { NodeDnsProvider, ParkingIpRegistry, type DnsProvider } from '../providers/dns/index.js';
import { type RateLimiterLike, RateLimiter } from '../providers/rate-limiter.js';
import { FailoverRdapProvider } from '../providers/rdap/index.js';
import { type RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { RdapResult } from '../types/domain-status.js';
import {
  NodeWhoisProviderWithIanaFallback,
  buildPerTldWhoisRateLimiters,
} from '../providers/whois/index.js';
import { RetryingWhoisProvider, WHOIS_CIRCUIT_BREAKER } from './retrying-whois-provider.js';
import { withRetry } from '../providers/retryable-provider.js';
import type { WhoisProvider as WhoisProviderInterface } from '../providers/whois/whois-provider.js';
import type { DnsCheckResult } from '../types/domain-status.js';
import { DomainStatus } from '../types/domain-status.js';
import { RetryingRdapProvider } from './retrying-rdap-provider.js';
import { RDAP_CIRCUIT_BREAKER } from '../providers/circuit-breaker.js';
import { CdxWaybackProvider } from '../providers/wayback/index.js';
import type { WaybackProvider, WaybackResult } from '../providers/wayback/wayback-provider.js';
import { type RedisClient, type RedisCacheProvider } from '../providers/redis/index.js';
import { RedisRateLimiter } from '../providers/redis/redis-rate-limiter.js';

export function buildKeywordProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: KeywordProvider; cached: KeywordProvider & { clearCache(): void } } {
  const raw = createKeywordProvider(
    config.KEYWORD_PROVIDER,
    {
      dataFilePath: config.KEYWORD_DATA_PATH,
      googleAdsClientId: config.GOOGLE_ADS_CLIENT_ID,
      googleAdsClientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      googleAdsRefreshToken: config.GOOGLE_ADS_REFRESH_TOKEN,
      googleAdsDeveloperToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      googleAdsCustomerId: config.GOOGLE_ADS_CUSTOMER_ID,
    },
    providerCacheRepo,
  );

  const cache = CachedProvider.createJson<KeywordMetrics>(
    (term, signal) => raw.getMetrics(term, signal),
    providerCacheRepo,
    'keyword',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );
  const cached: KeywordProvider & { clearCache: () => void } = {
    getMetrics: (term: string, signal?: AbortSignal) => cache.get(term, signal),
    clearCache: () => cache.clearCache(),
  };

  return { raw, cached };
}

export function buildCompsProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: CompsProvider; cached: CompsProvider & { clearCache(): void } } {
  const raw = createCompsProvider(config.COMPS_PROVIDER, {
    csvFilePath: config.COMPS_DATA_PATH,
    namebioApiKey: config.NAMEBIO_API_KEY,
  });

  const cache = CachedProvider.createJson<ComparableSale[]>(
    (term, signal) => raw.getSales(term, signal),
    providerCacheRepo,
    'comps',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );
  const cached: CompsProvider & { clearCache: () => void } = {
    getSales: (term: string, signal?: AbortSignal) => cache.get(term, signal),
    clearCache: () => cache.clearCache(),
  };

  return { raw, cached };
}

export interface BuiltRdapProviders {
  raw: RdapProvider;
  withRetry: RdapProvider;
  cached: RdapProvider;
}

export function buildRdapProviders(
  config: Config,
  rdapRateLimiter: RateLimiterLike,
  providerCacheRepo: ProviderCacheRepository,
): BuiltRdapProviders {
  const rdapBootstrapUrls: string[] = ((): string[] => {
    if (!config.RDAP_BOOTSTRAP_URLS) return [];
    try {
      return JSON.parse(config.RDAP_BOOTSTRAP_URLS) as string[];
    } catch {
      return [];
    }
  })();

  const raw: RdapProvider =
    rdapBootstrapUrls.length > 0
      ? FailoverRdapProvider.fromConfig(rdapBootstrapUrls, rdapRateLimiter)
      : new FailoverRdapProvider();

  const withRetryProvider = new RetryingRdapProvider(raw, {}, RDAP_CIRCUIT_BREAKER);

  const rdapCache = CachedProvider.createJson<RdapResult>(
    (domain, signal) => withRetryProvider.confirm(domain, signal),
    providerCacheRepo,
    'rdap',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );
  const cached: RdapProvider = {
    name: `${withRetryProvider.name}(cache)`,
    confirm: (domain: string, signal?: AbortSignal) => rdapCache.get(domain, signal),
  };

  return { raw, withRetry: withRetryProvider, cached };
}

export function buildDnsProvider(
  config: Config,
  rateLimiter?: RateLimiterLike,
  providerCacheRepo?: ProviderCacheRepository,
  redisCache?: RedisCacheProvider<DnsCheckResult>,
): DnsProvider {
  const parkingRegistry = ParkingIpRegistry.load(config.DNS_PARKING_IPS_PATH);

  const dohResolvers: { name: string; url: string }[] = ((): { name: string; url: string }[] => {
    if (!config.DNS_RESOLVER_URLS) return [];
    try {
      return JSON.parse(config.DNS_RESOLVER_URLS) as { name: string; url: string }[];
    } catch {
      return [];
    }
  })();

  const inner = new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy: config.DNS_LOOKUP_STRATEGY,
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    dohResolvers,
    semaphoreConcurrency: config.DNS_SEMAPHORE_CONCURRENCY,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    parkingEnabled: config.DNS_PARKING_CHECK_ENABLED,
    parkingRegistry,
    healthCheckDomain: config.DNS_HEALTH_CHECK_DOMAIN,
    ...(redisCache !== undefined ? { redisCache } : {}),
  });

  const wrappedCheckAvailability = async (
    domain: string,
    signal?: AbortSignal,
  ): Promise<DnsCheckResult> => {
    return withRetry(
      async (s) => {
        if (rateLimiter) await rateLimiter.acquire();
        return inner.checkAvailability(domain, s);
      },
      `dns:${domain}`,
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
      signal,
    );
  };

  // DB-backed persistent cache layer (consistent with keyword, comps, RDAP providers).
  // When providerCacheRepo is unavailable (tests), skip DB caching.
  const dnsCache = providerCacheRepo
    ? CachedProvider.createJson<DnsCheckResult>(
        (domain, s) => wrappedCheckAvailability(domain, s),
        providerCacheRepo,
        'dns',
        config.PROVIDER_CACHE_TTL_DAYS ?? 7,
        config.PROVIDER_MEMORY_CACHE_SIZE,
        config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
      )
    : null;

  const cachedCheckAvailability: (domain: string, signal?: AbortSignal) => Promise<DnsCheckResult> =
    dnsCache
      ? async (domain, signal): Promise<DnsCheckResult> => dnsCache.get(domain, signal)
      : wrappedCheckAvailability;

  const dnsProvider: DnsProvider = {
    name: dnsCache ? 'DnsProvider(cached+retry)' : 'DnsProvider(withRetry)',
    checkAvailability: cachedCheckAvailability,
    clearCache: () => {
      inner.clearCache();
      dnsCache?.clearCache();
    },
    checkBulk: async (domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]> => {
      const results: DnsCheckResult[] = [];
      const chunkSize = config.DNS_BULK_CONCURRENCY;
      for (let i = 0; i < domains.length; i += chunkSize) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = domains.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(
          chunk.map((d) =>
            cachedCheckAvailability(d, signal).catch(() => ({
              domain: d,
              status: DomainStatus.Unknown,
              checkedAt: new Date().toISOString(),
            })),
          ),
        );
        results.push(...chunkResults);
      }
      return results;
    },
  };
  return dnsProvider;
}

export interface BuiltWhoisProvider {
  raw: NodeWhoisProviderWithIanaFallback;
  withRetry: WhoisProviderInterface;
}

export function buildWhoisProviders(config: Config): BuiltWhoisProvider {
  const whoisDefaultLimiter = new RateLimiter({
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });

  const whoisPerTldLimiters = buildPerTldWhoisRateLimiters(config.WHOIS_RATE_LIMIT_OVERRIDES, {
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });

  const raw = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    defaultRateLimiter: whoisDefaultLimiter,
    perTldRateLimiters: whoisPerTldLimiters,
  });

  const withRetry = new RetryingWhoisProvider(raw, {}, WHOIS_CIRCUIT_BREAKER);

  return { raw, withRetry };
}

export function buildWaybackProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): WaybackProvider | undefined {
  if (!config.WAYBACK_ENABLED) return undefined;

  const waybackLimiter = new RateLimiter({
    maxTokens: config.WAYBACK_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WAYBACK_RATE_LIMIT_TOKENS,
    intervalMs: config.WAYBACK_RATE_LIMIT_INTERVAL_MS,
  });

  const raw = new CdxWaybackProvider(undefined, waybackLimiter, config.WAYBACK_TIMEOUT_MS);

  const cache = CachedProvider.createJson<WaybackResult>(
    (domain, signal) => raw.getExpiryData(domain, signal),
    providerCacheRepo,
    'wayback',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );

  const cached: WaybackProvider = {
    getExpiryData: (domain: string, signal?: AbortSignal) => cache.get(domain, signal),
  };

  return cached;
}

function createRateLimiter(
  tokens: number,
  intervalMs: number,
  namespace: string,
  redisClient?: RedisClient | undefined,
): RateLimiterLike {
  if (redisClient) {
    return new RedisRateLimiter({ tokens, intervalMs, namespace }, redisClient);
  }
  return new RateLimiter({
    maxTokens: tokens,
    tokensPerInterval: tokens,
    intervalMs,
  });
}

export interface BuiltRateLimiters {
  rdap: RateLimiterLike;
  uspto: RateLimiterLike;
  euipo: RateLimiterLike;
  wayback: RateLimiterLike;
  dns: RateLimiterLike;
}

export function buildRateLimiters(
  config: Config,
  redisClient?: RedisClient | undefined,
): BuiltRateLimiters {
  const rdap = createRateLimiter(
    config.RDAP_RATE_LIMIT_TOKENS,
    config.RDAP_RATE_LIMIT_INTERVAL_MS,
    'rdap',
    redisClient,
  );
  const uspto = createRateLimiter(
    config.USPTO_RATE_LIMIT_TOKENS,
    config.USPTO_RATE_LIMIT_INTERVAL_MS,
    'uspto',
    redisClient,
  );
  const euipo = createRateLimiter(
    config.EUIPO_RATE_LIMIT_TOKENS,
    config.EUIPO_RATE_LIMIT_INTERVAL_MS,
    'euipo',
    redisClient,
  );
  const wayback = createRateLimiter(
    config.WAYBACK_RATE_LIMIT_TOKENS,
    config.WAYBACK_RATE_LIMIT_INTERVAL_MS,
    'wayback',
    redisClient,
  );
  const dns = createRateLimiter(
    config.DNS_RATE_LIMIT_TOKENS,
    config.DNS_RATE_LIMIT_INTERVAL_MS,
    'dns',
    redisClient,
  );
  return { rdap, uspto, euipo, wayback, dns };
}
