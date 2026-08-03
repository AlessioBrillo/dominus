// SPDX-License-Identifier: AGPL-3.0-only
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
import {
  NodeDnsProvider,
  ParkingIpRegistry,
  type DnsProvider,
  type DnsResolverGroup,
} from '../providers/dns/index.js';
import {
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
} from '../providers/dns/resolver-validator.js';
import { RateLimiter, type RateLimiterLike } from '../providers/rate-limiter.js';
import {
  RedisRateLimiter,
  DistributedCircuitBreaker,
  type RedisClient,
} from '../providers/redis/index.js';
import { FailoverRdapProvider, type RdapBootstrapUrlEntry } from '../providers/rdap/index.js';
import { IanaRdapBootstrap } from '../providers/rdap/rdap-bootstrap.js';
import { type RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { RdapResult } from '../types/domain-status.js';
import {
  NodeWhoisProviderWithIanaFallback,
  buildPerTldWhoisRateLimiters,
} from '../providers/whois/index.js';
import { RetryingWhoisProvider, WHOIS_CIRCUIT_BREAKER } from './retrying-whois-provider.js';
import type { WhoisProvider as WhoisProviderInterface } from '../providers/whois/whois-provider.js';
import { RetryingRdapProvider } from './retrying-rdap-provider.js';
import {
  CircuitBreaker,
  RDAP_CIRCUIT_BREAKER,
  RDAP_PER_SERVER_CIRCUIT_BREAKER,
  type ICircuitBreaker,
  type CircuitBreakerPolicy,
} from '../providers/circuit-breaker.js';
import { CdxWaybackProvider } from '../providers/wayback/index.js';
import type { WaybackProvider, WaybackResult } from '../providers/wayback/wayback-provider.js';
import type { ConsensusDnsConfig } from '../pipeline/stages/dns-prefilter-stage.js';
import { getLogger } from '../logger.js';

export function buildKeywordProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: KeywordProvider; cached: KeywordProvider } {
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

  return { raw, cached: cached as KeywordProvider };
}

export function buildCompsProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: CompsProvider; cached: CompsProvider } {
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

  return { raw, cached: cached as CompsProvider };
}

export interface BuiltRdapProviders {
  raw: RdapProvider;
  withRetry: RdapProvider;
  cached: RdapProvider;
}

/**
 * Decide whether an RDAP result may be persisted in the provider cache.
 * Only definitive verdicts (available / registered / premium) are stable
 * enough to cache: transient outcomes (unknown, error) reflect a failure of
 * the lookups themselves, not of the domain, and caching them for days would
 * freeze the domain's status. Mirrors the DNS layer's "never persist
 * unknown" policy.
 */
export function isRdapResultCacheable(result: RdapResult): boolean {
  return result.status !== 'unknown' && result.status !== 'error';
}

/**
 * Parse the RDAP_BOOTSTRAP_URLS env value into a list of entries. Each entry
 * is either a plain URL string (universal scope) or a {url, tlds} object
 * scoping the server to specific TLDs. Invalid JSON silently degrades to an
 * empty list (defaults take over).
 */
export function parseRdapBootstrapUrls(raw: string | undefined): RdapBootstrapUrlEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: RdapBootstrapUrlEntry[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        entries.push({ url: item });
      } else if (typeof item === 'object' && item !== null) {
        const candidate = item as { url?: unknown; tlds?: unknown };
        if (typeof candidate.url !== 'string') return [];
        const tlds = Array.isArray(candidate.tlds)
          ? candidate.tlds.filter((t): t is string => typeof t === 'string')
          : undefined;
        if (tlds === undefined || tlds.length === 0) {
          entries.push({ url: candidate.url });
        } else {
          entries.push({ url: candidate.url, tlds });
        }
      } else {
        return [];
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Choose the RDAP circuit breaker implementation at the factory boundary:
 * distributed (Redis-backed, shared across containers) when a Redis client
 * is connected, in-memory otherwise. This keeps the RDAP layer free of
 * Redis knowledge while letting cloud deployments share breaker state. */
export function buildRdapCircuitBreakers(redisClient?: RedisClient): {
  global: ICircuitBreaker;
  perServer: (name: string, policy: Partial<CircuitBreakerPolicy>) => ICircuitBreaker;
} {
  if (redisClient?.isConnected) {
    const name = 'rdap-global';
    return {
      global: new DistributedCircuitBreaker(name, RDAP_CIRCUIT_BREAKER, redisClient),
      perServer: (serverName, policy) =>
        new DistributedCircuitBreaker(
          `rdap-server:${serverName}`,
          { ...RDAP_PER_SERVER_CIRCUIT_BREAKER, ...policy },
          redisClient,
        ),
    };
  }
  return {
    global: new CircuitBreaker(RDAP_CIRCUIT_BREAKER),
    perServer: (_serverName, policy) =>
      new CircuitBreaker({
        ...RDAP_PER_SERVER_CIRCUIT_BREAKER,
        ...policy,
      }),
  };
}

export function buildRdapProviders(
  config: Config,
  rdapRateLimiter: RateLimiterLike,
  providerCacheRepo: ProviderCacheRepository,
  redisClient?: RedisClient,
): BuiltRdapProviders {
  const rdapBootstrapUrls = parseRdapBootstrapUrls(config.RDAP_BOOTSTRAP_URLS);
  const breakers = buildRdapCircuitBreakers(redisClient);

  const ianaBootstrap = config.RDAP_BOOTSTRAP_URL
    ? new IanaRdapBootstrap(config.RDAP_BOOTSTRAP_URL)
    : undefined;
  // Warm the IANA bootstrap (RFC 7484) at startup, fire-and-forget, so the
  // first RDAP query of the process does not stall on the cold fetch.
  ianaBootstrap?.warm();

  const raw: RdapProvider =
    rdapBootstrapUrls.length > 0
      ? FailoverRdapProvider.fromConfig(
          rdapBootstrapUrls,
          rdapRateLimiter,
          undefined,
          breakers.perServer,
        )
      : FailoverRdapProvider.withDefaults(
          rdapRateLimiter,
          undefined,
          ianaBootstrap,
          breakers.perServer,
        );

  const withRetryProvider = new RetryingRdapProvider(raw, {}, breakers.global);

  const rdapCache = CachedProvider.createJson<RdapResult>(
    (domain, signal) => withRetryProvider.confirm(domain, signal),
    providerCacheRepo,
    'rdap',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
    isRdapResultCacheable,
  );
  const cached: RdapProvider = {
    name: `${withRetryProvider.name}(cache)`,
    confirm: (domain: string, signal?: AbortSignal) => rdapCache.get(domain, signal),
  };

  return { raw, withRetry: withRetryProvider, cached };
}

export function buildDnsProvider(
  config: Config,
  providerCacheRepo?: ProviderCacheRepository,
  rateLimiter?: RateLimiterLike,
): DnsProvider {
  const nameservers: string[] | undefined = resolveNameservers(config.DNS_NAMESERVERS);

  const parkingRegistry = ParkingIpRegistry.load(config.DNS_PARKING_IPS_PATH);

  const resolverGroups = config.DNS_RESOLVER_GROUPS as DnsResolverGroup[] | undefined;

  const provider = new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy: config.DNS_LOOKUP_STRATEGY,
    ...(resolverGroups !== undefined ? { resolverGroups } : {}),
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    parkingEnabled: config.DNS_PARKING_CHECK_ENABLED,
    parkingRegistry,
    rateLimiter,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
    persistentCache:
      config.DNS_PERSISTENT_CACHE_ENABLED && providerCacheRepo !== undefined
        ? providerCacheRepo
        : undefined,
    persistentCacheTtlHours: config.DNS_PERSISTENT_CACHE_TTL_HOURS,
    persistentAvailableStaleMs: config.DNS_PERSISTENT_AVAILABLE_STALE_HOURS * 60 * 60_000,
    dotPoolMaxQueued: config.DNS_DOT_POOL_MAX_QUEUED,
    ...(nameservers !== undefined ? { nameservers } : {}),
    useDedicatedResolver: config.DNS_USE_DEDICATED_RESOLVER,
  });

  // Startup validation: probe known domains through each resolver group.
  // Non-fatal on failure (the groups fall back to per-domain checks at runtime),
  // but logged prominently so the operator knows which groups are degraded.
  validateResolverGroups(provider).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    getLogger().error(
      { err: message },
      'DNS: resolver group validation failed — groups may be degraded at runtime',
    );
  });

  return provider;
}

function resolveNameservers(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const servers = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return servers.length > 0 ? servers : undefined;
}

/**
 * Secondary DNS provider for 2-of-3 consensus cross-validation (see
 * DNS_CONSENSUS_ENABLED). Uses a resolver strategy disjoint from the primary
 * provider and skips the persistent cache — this is a verification query,
 * not a candidate for reuse across runs.
 */
export function buildSecondaryDnsProvider(
  config: Config,
  rateLimiter?: RateLimiterLike,
): DnsProvider {
  return new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy: config.DNS_CONSENSUS_STRATEGY,
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    rateLimiter,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
  });
}

/**
 * Builds the DNS 2-of-3 consensus config for the pipeline's DNS prefilter
 * stage, or undefined when DNS_CONSENSUS_ENABLED is off (the default).
 */
export function buildDnsConsensusConfig(
  config: Config,
  rateLimiter?: RateLimiterLike,
): ConsensusDnsConfig | undefined {
  if (!config.DNS_CONSENSUS_ENABLED) return undefined;
  if (
    !validateConsensusStrategyDisjointness(
      config.DNS_CONSENSUS_ENABLED,
      config.DNS_LOOKUP_STRATEGY,
      config.DNS_CONSENSUS_STRATEGY,
    )
  ) {
    return undefined;
  }
  return { secondaryProvider: buildSecondaryDnsProvider(config, rateLimiter) };
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

export interface BuiltRateLimiters {
  rdap: RateLimiterLike;
  uspto: RateLimiterLike;
  euipo: RateLimiterLike;
  wayback: RateLimiterLike;
  dns: RateLimiterLike;
}

export function buildRateLimiters(config: Config, redisClient?: RedisClient): BuiltRateLimiters {
  const useRedis = redisClient?.isConnected ?? false;

  if (useRedis) {
    const rdap = new RedisRateLimiter(
      {
        tokens: config.RDAP_RATE_LIMIT_TOKENS,
        intervalMs: config.RDAP_RATE_LIMIT_INTERVAL_MS,
        namespace: 'rdap',
      },
      redisClient,
    );
    const uspto = new RedisRateLimiter(
      {
        tokens: config.USPTO_RATE_LIMIT_TOKENS,
        intervalMs: config.USPTO_RATE_LIMIT_INTERVAL_MS,
        namespace: 'uspto',
      },
      redisClient,
    );
    const euipo = new RedisRateLimiter(
      {
        tokens: config.EUIPO_RATE_LIMIT_TOKENS,
        intervalMs: config.EUIPO_RATE_LIMIT_INTERVAL_MS,
        namespace: 'euipo',
      },
      redisClient,
    );
    const wayback = new RedisRateLimiter(
      {
        tokens: config.WAYBACK_RATE_LIMIT_TOKENS,
        intervalMs: config.WAYBACK_RATE_LIMIT_INTERVAL_MS,
        namespace: 'wayback',
      },
      redisClient,
    );
    const dns = new RedisRateLimiter(
      {
        tokens: config.DNS_RATE_LIMIT_TOKENS,
        intervalMs: config.DNS_RATE_LIMIT_INTERVAL_MS,
        namespace: 'dns',
      },
      redisClient,
    );
    return { rdap, uspto, euipo, wayback, dns };
  }

  const rdap = new RateLimiter({
    maxTokens: config.RDAP_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.RDAP_RATE_LIMIT_TOKENS,
    intervalMs: config.RDAP_RATE_LIMIT_INTERVAL_MS,
  });
  const uspto = new RateLimiter({
    maxTokens: config.USPTO_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.USPTO_RATE_LIMIT_TOKENS,
    intervalMs: config.USPTO_RATE_LIMIT_INTERVAL_MS,
  });
  const euipo = new RateLimiter({
    maxTokens: config.EUIPO_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.EUIPO_RATE_LIMIT_TOKENS,
    intervalMs: config.EUIPO_RATE_LIMIT_INTERVAL_MS,
  });
  const wayback = new RateLimiter({
    maxTokens: config.WAYBACK_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WAYBACK_RATE_LIMIT_TOKENS,
    intervalMs: config.WAYBACK_RATE_LIMIT_INTERVAL_MS,
  });
  const dns = new RateLimiter({
    maxTokens: config.DNS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.DNS_RATE_LIMIT_TOKENS,
    intervalMs: config.DNS_RATE_LIMIT_INTERVAL_MS,
  });
  return { rdap, uspto, euipo, wayback, dns };
}
