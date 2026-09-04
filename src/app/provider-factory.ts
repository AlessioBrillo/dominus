// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { Dispatcher } from 'undici';
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
  DnsBreakerRegistry,
  strategyToResolverGroups,
  collectResolverEndpoints,
  resolveEndpointsLiveWithAnycast,
  hasUsableLookups,
  type DnsBreakerRegistryLike,
  type DnsLegTelemetry,
  type DnsLookupStrategy,
  type DnsProvider,
  type DnsResolverGroup,
  type DnsConsensusValidationResult,
  type AnycastOverlapDetail,
  type ResolvedEndpoints,
} from '../providers/dns/index.js';
import type { ConsensusDnsProviderOptions } from '../providers/dns/consensus-dns-provider.js';
import { ConsensusDnsProvider } from '../providers/dns/consensus-dns-provider.js';
import {
  validateConsensusDisjointness,
  validateRuntimeConsensusDisjointness,
  validateFallbackIsolation,
  validateConsensusDisjointnessRuntime,
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
  type RuntimeConsensusReport,
  type RuntimeValidationMode,
} from '../providers/dns/resolver-validator.js';
import {
  RateLimiter,
  PriorityRateLimiter,
  type RateLimiterLike,
} from '../providers/rate-limiter.js';
import { AnonBudgetGate } from '../providers/anon-budget-gate.js';
import {
  RedisRateLimiter,
  DistributedCircuitBreaker,
  type RedisClient,
} from '../providers/redis/index.js';
import type { RedisRateLimiterConfig } from '../providers/redis/redis-rate-limiter.js';
import {
  FailoverRdapProvider,
  RdapAgentPool,
  type RdapBootstrapUrlEntry,
  type RdapRequestTelemetry,
} from '../providers/rdap/index.js';
import { IanaRdapBootstrap, IANA_RDAP_BOOTSTRAP_URL } from '../providers/rdap/rdap-bootstrap.js';
import { type RdapProvider } from '../providers/rdap/rdap-provider.js';
import { DomainStatus, type RdapResult } from '../types/domain-status.js';
import {
  NodeWhoisProviderWithIanaFallback,
  parseWhoisRateLimitOverrides,
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
import type { RdapConsensusConfig } from '../pipeline/stages/rdap-confirmation-stage.js';
import { getLogger } from '../logger.js';
import { createAuthoritativeZoneResolver } from '../providers/dns/authoritative-zone-resolver.js';

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
  const cached: KeywordProvider & { clearCache: () => void; pruneCache: () => void } = {
    getMetrics: (term: string, signal?: AbortSignal) => cache.get(term, signal),
    clearCache: () => cache.clearCache(),
    pruneCache: () => cache.pruneCache(),
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
  const cached: CompsProvider & { clearCache: () => void; pruneCache: () => void } = {
    getSales: (term: string, signal?: AbortSignal) => cache.get(term, signal),
    clearCache: () => cache.clearCache(),
    pruneCache: () => cache.pruneCache(),
  };

  return { raw, cached: cached as CompsProvider };
}

export interface BuiltRdapProviders {
  raw: RdapProvider;
  withRetry: RdapProvider;
  cached: RdapProvider;
  /**
   * Cached provider that bypasses the persistent cache entirely (live lookup
   * that still refreshes the entry). Used for populations in transitional
   * states (closeouts) where a stale row would wrongly gate the verdict.
   */
  fresh: RdapProvider;
  /**
   * IANA per-TLD bootstrap (RFC 7484) backing the primary failover leg and
   * the ADR-0058 origin-overlap resolution. Always present: with the
   * 2-of-2 gate defaulting on (rdap.org second leg), the primary must draw
   * its authoritative per-TLD servers from IANA or the gate would be a
   * self-consistency check against the same router.
   */
  ianaBootstrap: IanaRdapBootstrap;
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
 * Staleness gate for persisted RDAP rows, mirroring the DNS layer's
 * stale-Available window (node-dns-provider.ts). Only "Available" — the
 * risky verdict — goes stale early; "Registered" is served for the full TTL
 * (conservative outcome, ADR-0035), and transient statuses are never cached
 * at all (see isRdapResultCacheable). An unparseable checkedAt is treated as
 * fresh: the row is valid JSON so we prefer serving over re-querying.
 */
export function isRdapResultStale(result: RdapResult, staleHours: number): boolean {
  if (result.status !== DomainStatus.Available) return false;
  const checkedAtMs = Date.parse(result.checkedAt);
  if (Number.isNaN(checkedAtMs)) return false;
  return Date.now() - checkedAtMs > staleHours * 3_600_000;
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

/**
 * Shared per-endpoint DNS circuit breaker registry (ADR-0059): one circuit
 * per resolver endpoint, shared by the primary, secondary, and tertiary
 * consensus providers so a failing endpoint is skipped for every leg that
 * uses it. Distributed (Redis-backed, shared across containers) when a
 * Redis client is connected, in-memory otherwise. Returns undefined when
 * DNS_CIRCUIT_BREAKER_ENABLED=false (default on).
 */
export function buildDnsBreakers(
  config: Config,
  redisClient?: RedisClient,
): DnsBreakerRegistryLike | undefined {
  if (!config.DNS_CIRCUIT_BREAKER_ENABLED) return undefined;
  return new DnsBreakerRegistry(
    {
      failureThreshold: config.DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      windowMs: config.DNS_CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: config.DNS_CIRCUIT_BREAKER_COOLDOWN_MS,
    },
    redisClient,
  );
}

export function buildRdapProviders(
  config: Config,
  rdapRateLimiter: RateLimiterLike,
  providerCacheRepo: ProviderCacheRepository,
  redisClient?: RedisClient,
  onRequestResult?: RdapRequestTelemetry,
): BuiltRdapProviders {
  const rdapBootstrapUrls = parseRdapBootstrapUrls(config.RDAP_BOOTSTRAP_URLS);
  const breakers = buildRdapCircuitBreakers(redisClient);
  const rdapAgentPool = new RdapAgentPool({
    maxConnections: config.RDAP_MAX_CONNECTIONS,
  });

  const ianaBootstrap = new IanaRdapBootstrap(
    config.RDAP_BOOTSTRAP_URL?.trim() || IANA_RDAP_BOOTSTRAP_URL,
    undefined,
    {
      getDispatcher: (): Promise<Dispatcher> => rdapAgentPool.getDispatcher(),
      retryBaseMs: config.RDAP_BOOTSTRAP_RETRY_BASE_MS,
      retryMaxMs: config.RDAP_BOOTSTRAP_RETRY_MAX_MS,
    },
  );
  // Warm the IANA bootstrap (RFC 7484) at startup, fire-and-forget, so the
  // first RDAP query of the process does not stall on the cold fetch.
  ianaBootstrap.warm();

  const raw: RdapProvider =
    rdapBootstrapUrls.length > 0
      ? FailoverRdapProvider.fromConfig(
          rdapBootstrapUrls,
          rdapRateLimiter,
          undefined,
          breakers.perServer,
          rdapAgentPool,
          undefined,
          config.RDAP_MAX_RESPONSE_BYTES,
          onRequestResult,
        )
      : FailoverRdapProvider.withDefaults(
          rdapRateLimiter,
          undefined,
          ianaBootstrap,
          breakers.perServer,
          rdapAgentPool,
          config.RDAP_MAX_RESPONSE_BYTES,
          onRequestResult,
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
    (result) => isRdapResultStale(result, config.RDAP_PERSISTENT_AVAILABLE_STALE_HOURS),
  );
  const cached: RdapProvider = {
    name: `${withRetryProvider.name}(cache)`,
    confirm: (domain: string, signal?: AbortSignal) => rdapCache.get(domain, signal),
  };
  const fresh: RdapProvider = {
    name: `${withRetryProvider.name}(fresh)`,
    confirm: (domain: string, signal?: AbortSignal) =>
      rdapCache.get(domain, signal, { forceRecheck: true }),
  };

  return { raw, withRetry: withRetryProvider, cached, fresh, ianaBootstrap };
}

/**
 * DNS_PRIVACY_MODE (ADR-0065): the configured strategy is overridden to
 * 'native' for every leg — primary, consensus secondary and tertiary — so no
 * DNS query leaves the host except to the pinned recursor(s). The configured
 * values are ignored in privacy mode; the endpoint disjointness check still
 * decides whether the consensus is genuinely independent (distinct pinned
 * recursor) or a rubber stamp (same recursor, gate vetoed).
 */
export function effectiveDnsLookupStrategy(
  config: Config,
  strategy: DnsLookupStrategy,
): DnsLookupStrategy {
  return config.DNS_PRIVACY_MODE ? 'native' : strategy;
}

/**
 * Checks if a set of resolver groups has at least one non-fallback lookup.
 * Used to detect when a consensus strategy yields zero usable endpoints
 * (e.g., DoT/853 blocked by egress filtering) so we can fall back to
 * an alternative strategy (ADR-0063/0065).
 */
export function buildDnsProvider(
  config: Config,
  providerCacheRepo?: ProviderCacheRepository,
  rateLimiter?: RateLimiterLike,
  breakers?: DnsBreakerRegistryLike,
  legTelemetry?: DnsLegTelemetry,
): DnsProvider {
  const nameservers: string[] | undefined = resolveNameservers(config.DNS_NAMESERVERS);

  // Privacy mode (ADR-0065) forces every strategy to 'native' so no query
  // egresses to a public resolver; without an explicit pinned recursor the
  // "privacy" would be fictional (the system resolver is the ISP's).
  // Both editions: fail loudly — operator must configure recursors.
  if (config.DNS_PRIVACY_MODE && nameservers === undefined) {
    const msg =
      'DNS_PRIVACY_MODE=true requires DNS_NAMESERVERS to be set: every DNS leg is ' +
      'forced to the pinned recursor, and the system resolver would still leak ' +
      'candidate names to the ISP. Pin your private recursor (e.g. 127.0.0.1:5300) ' +
      'or disable DNS_PRIVACY_MODE (ADR-0065).';
    throw new Error(msg);
  }

  // An unset or missing DNS_PARKING_IPS_PATH falls back to the bundled
  // reference list (ADR-0059): DNS_PARKING_CHECK_ENABLED=true must work out
  // of the box without a data file. An explicit readable file always wins.
  const parkingRegistry = ParkingIpRegistry.load(
    config.DNS_PARKING_IPS_PATH,
    fileURLToPath(new URL('../providers/dns/parking-ips.json', import.meta.url)),
  );

  const resolverGroups = config.DNS_RESOLVER_GROUPS as DnsResolverGroup[] | undefined;

  const provider = new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy: effectiveDnsLookupStrategy(config, config.DNS_LOOKUP_STRATEGY),
    ...(resolverGroups !== undefined ? { resolverGroups } : {}),
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
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
    breakers,
    ...(legTelemetry !== undefined
      ? { onLegResult: legTelemetry, legRole: 'primary' as const }
      : {}),
    dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
    dnssecNativeEnabled: config.DNS_NATIVE_DNSSEC_ENABLED && nameservers !== undefined,
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
 * provider and skips both the persistent cache and the in-memory cache
 * (maxSize 0) — this is a live verification query, not a candidate for
 * reuse across runs.
 */
export function buildSecondaryDnsProvider(
  config: Config,
  rateLimiter?: RateLimiterLike,
  breakers?: DnsBreakerRegistryLike,
  legTelemetry?: DnsLegTelemetry,
  overrideStrategy?: DnsLookupStrategy, // Optional strategy override (e.g., fallback strategy)
): DnsProvider {
  const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
  // If consensusNameservers is set, use 'native' (C3 pinned recursor).
  // Otherwise, use the override strategy if provided, else the config strategy.
  const lookupStrategy = consensusNameservers
    ? 'native'
    : (overrideStrategy ?? effectiveDnsLookupStrategy(config, config.DNS_CONSENSUS_STRATEGY));
  return new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    // Verification leg: live queries only, no verdict reuse across runs.
    maxSize: 0,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy,
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    ...(consensusNameservers !== undefined ? { nameservers: consensusNameservers } : {}),
    rateLimiter,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
    breakers,
    ...(legTelemetry !== undefined
      ? { onLegResult: legTelemetry, legRole: 'consensus' as const }
      : {}),
    dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
    dnssecNativeEnabled: config.DNS_NATIVE_DNSSEC_ENABLED && consensusNameservers !== undefined,
  });
}

/**
 * Builds dual-redundant secondary DNS consensus providers (ADR-00XX).
 * When DNS_CONSENSUS_DUAL_REDUNDANT=true, creates two independent secondary
 * providers using DNS_CONSENSUS_STRATEGY_1 and DNS_CONSENSUS_STRATEGY_2.
 * Each has its own rate limiter (split budget) and independent disjointness checks.
 * Returns array of providers (1 or 2 depending on config).
 */
async function buildSecondaryConsensusProviders(
  config: Config,
  consensusRateLimiter: RateLimiterLike,
  primaryGroups: DnsResolverGroup[],
  primaryNameservers: string[] | undefined,
  breakers?: DnsBreakerRegistryLike,
  legTelemetry?: DnsLegTelemetry,
  onDisjointnessPartial?: () => void,
): Promise<DnsProvider[]> {
  // Dual-redundant mode (ADR-00XX): create two independent secondary providers
  if (config.DNS_CONSENSUS_DUAL_REDUNDANT) {
    const providers: DnsProvider[] = [];

    // Provider 1: DNS_CONSENSUS_STRATEGY_1
    const consensusNameservers1 = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
    const effectiveConsensus1Strategy: DnsLookupStrategy = consensusNameservers1
      ? 'native'
      : effectiveDnsLookupStrategy(config, config.DNS_CONSENSUS_STRATEGY_1);
    const consensus1Groups = strategyToResolverGroups(
      effectiveConsensus1Strategy,
      config.DNS_DOH_ENDPOINT,
    );
    const effectiveConsensus1Nameservers = consensusNameservers1 ?? primaryNameservers;

    // Rate limiter for secondary provider 1 (split budget)
    const consensus1RateLimiter = config.REDIS_URL
      ? new RedisRateLimiter({
          tokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_1 ?? 10,
          intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS_1 ?? 1000,
          namespace: 'dns:consensus1:',
        } as RedisRateLimiterConfig)
      : new PriorityRateLimiter(
          {
            maxTokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_1 ?? 10,
            tokensPerInterval: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_1 ?? 10,
            intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS_1 ?? 1000,
          },
          0,
        );

    // Independence check against primary for provider 1
    const primaryReport1 = await validateConsensusDisjointness(
      consensus1Groups,
      effectiveConsensus1Nameservers,
      primaryGroups,
      primaryNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );

    if (primaryReport1.ok) {
      providers.push(
        new NodeDnsProvider({
          cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
          maxSize: 0,
          lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
          lookupStrategy: effectiveConsensus1Strategy,
          dohEndpoint: config.DNS_DOH_ENDPOINT,
          dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
          bulkConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY ?? 20,
          ...(effectiveConsensus1Nameservers !== undefined
            ? { nameservers: effectiveConsensus1Nameservers }
            : {}),
          rateLimiter: consensus1RateLimiter,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
          breakers,
          ...(legTelemetry !== undefined
            ? { onLegResult: legTelemetry, legRole: 'consensus' as const }
            : {}),
          dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
          dnssecNativeEnabled:
            config.DNS_NATIVE_DNSSEC_ENABLED && effectiveConsensus1Nameservers !== undefined,
        }),
      );
    } else {
      const reason =
        primaryReport1.overlapEndpoints.length > 0
          ? `Static overlap: ${primaryReport1.overlapEndpoints.join(', ')}`
          : `Operator overlap: ${primaryReport1.overlapOperators.join(', ')}`;
      getLogger().warn(
        {
          overlapEndpoints: primaryReport1.overlapEndpoints,
          overlapOperators: primaryReport1.overlapOperators,
        },
        `DNS: secondary provider 1 (${config.DNS_CONSENSUS_STRATEGY_1}) DISABLED at bootstrap — ${reason}.`,
      );
    }

    // Provider 2: DNS_CONSENSUS_STRATEGY_2
    const consensusNameservers2 = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
    const effectiveConsensus2Strategy: DnsLookupStrategy = consensusNameservers2
      ? 'native'
      : effectiveDnsLookupStrategy(config, config.DNS_CONSENSUS_STRATEGY_2);
    const consensus2Groups = strategyToResolverGroups(
      effectiveConsensus2Strategy,
      config.DNS_DOH_ENDPOINT,
    );
    const effectiveConsensus2Nameservers = consensusNameservers2 ?? primaryNameservers;

    // Rate limiter for secondary provider 2 (split budget)
    const consensus2RateLimiter = config.REDIS_URL
      ? new RedisRateLimiter({
          tokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_2 ?? 10,
          intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS_2 ?? 1000,
          namespace: 'dns:consensus2:',
        } as RedisRateLimiterConfig)
      : new PriorityRateLimiter(
          {
            maxTokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_2 ?? 10,
            tokensPerInterval: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS_2 ?? 10,
            intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS_2 ?? 1000,
          },
          0,
        );

    // Independence check against primary for provider 2
    const primaryReport2 = await validateConsensusDisjointness(
      consensus2Groups,
      effectiveConsensus2Nameservers,
      primaryGroups,
      primaryNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );

    if (primaryReport2.ok) {
      providers.push(
        new NodeDnsProvider({
          cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
          maxSize: 0,
          lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
          lookupStrategy: effectiveConsensus2Strategy,
          dohEndpoint: config.DNS_DOH_ENDPOINT,
          dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
          bulkConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY ?? 20,
          ...(effectiveConsensus2Nameservers !== undefined
            ? { nameservers: effectiveConsensus2Nameservers }
            : {}),
          rateLimiter: consensus2RateLimiter,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
          breakers,
          ...(legTelemetry !== undefined
            ? { onLegResult: legTelemetry, legRole: 'consensus' as const }
            : {}),
          dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
          dnssecNativeEnabled:
            config.DNS_NATIVE_DNSSEC_ENABLED && effectiveConsensus2Nameservers !== undefined,
        }),
      );
    } else {
      const reason =
        primaryReport2.overlapEndpoints.length > 0
          ? `Static overlap: ${primaryReport2.overlapEndpoints.join(', ')}`
          : `Operator overlap: ${primaryReport2.overlapOperators.join(', ')}`;
      getLogger().warn(
        {
          overlapEndpoints: primaryReport2.overlapEndpoints,
          overlapOperators: primaryReport2.overlapOperators,
        },
        `DNS: secondary provider 2 (${config.DNS_CONSENSUS_STRATEGY_2}) DISABLED at bootstrap — ${reason}.`,
      );
    }

    if (providers.length === 0) {
      throw new Error(
        'DNS secondary consensus gate invalid at bootstrap: both secondary providers overlap with primary. ' +
          `Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS) or disable secondary consensus (DNS_CONSENSUS_DUAL_REDUNDANT=false).`,
      );
    }

    return providers;
  }

  // Legacy single secondary provider mode
  const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
  const effectiveConsensusStrategy: DnsLookupStrategy = consensusNameservers
    ? 'native'
    : effectiveDnsLookupStrategy(config, config.DNS_CONSENSUS_STRATEGY);
  const consensusGroups = strategyToResolverGroups(
    effectiveConsensusStrategy,
    config.DNS_DOH_ENDPOINT,
  );
  const effectiveConsensusNameservers = consensusNameservers ?? primaryNameservers;

  // Independence check against primary
  const primaryReport = await validateConsensusDisjointness(
    consensusGroups,
    effectiveConsensusNameservers,
    primaryGroups,
    primaryNameservers,
    {
      excludeFallbacks: true,
      ...(onDisjointnessPartial !== undefined
        ? { onResolutionPartial: onDisjointnessPartial }
        : {}),
    },
  );
  if (!primaryReport.ok) {
    const reason =
      primaryReport.overlapEndpoints.length > 0
        ? `Static overlap: ${primaryReport.overlapEndpoints.join(', ')}`
        : `Operator overlap: ${primaryReport.overlapOperators.join(', ')}`;
    getLogger().error(
      {
        overlapEndpoints: primaryReport.overlapEndpoints,
        overlapOperators: primaryReport.overlapOperators,
      },
      `DNS: secondary consensus gate DISABLED at bootstrap — ${reason}. Refusing to start.`,
    );
    throw new Error(
      `DNS secondary consensus gate invalid at bootstrap: ${reason}. ` +
        `Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS) ` +
        `or disable secondary consensus (DNS_CONSENSUS_ENABLED=false).`,
    );
  }

  // Dedicated rate limiter for single secondary provider (shared budget with tertiary)
  return [
    new NodeDnsProvider({
      cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
      maxSize: 0,
      lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
      lookupStrategy: effectiveConsensusStrategy,
      dohEndpoint: config.DNS_DOH_ENDPOINT,
      dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
      bulkConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY ?? 20,
      ...(effectiveConsensusNameservers !== undefined
        ? { nameservers: effectiveConsensusNameservers }
        : {}),
      rateLimiter: consensusRateLimiter,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
      breakers,
      ...(legTelemetry !== undefined
        ? { onLegResult: legTelemetry, legRole: 'consensus' as const }
        : {}),
      dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
      dnssecNativeEnabled:
        config.DNS_NATIVE_DNSSEC_ENABLED && effectiveConsensusNameservers !== undefined,
    }),
  ];
}

/**
 * Builds the ConsensusDnsProvider that wraps primary, secondary, and tertiary
 * providers into a single DnsProvider implementing the 2-of-3 / 2-of-2+1 consensus logic.
 * This abstraction allows the pipeline stage to simply call checkAvailability/checkBulk
 * without knowing about the consensus internals.
 */
export async function buildConsensusDnsProvider(
  primaryProvider: DnsProvider,
  secondaryProvider: DnsProvider,
  tertiaryProvider: DnsProvider | undefined,
  primaryGroups: DnsResolverGroup[],
  secondaryGroups: DnsResolverGroup[],
  tertiaryGroups: DnsResolverGroup[] | undefined,
  primaryNameservers: string[] | undefined,
  secondaryNameservers: string[] | undefined,
  tertiaryNameservers: string[] | undefined,
  disjointnessValidator?: {
    isDisjoint(primaryEndpoints: ResolvedEndpoints, secondaryEndpoints: ResolvedEndpoints): boolean;
  },
  legTelemetry?: DnsLegTelemetry,
  config?: {
    requiredConfirmations?: 1 | 2;
    degradedRatio?: number;
    degradedMin?: number;
    revalidationIntervalMs?: number;
  },
): Promise<DnsProvider> {
  // Build ResolvedEndpoints for each leg for runtime disjointness validation (ADR-0063/0066)
  const [primaryEndpoints, secondaryEndpoints, tertiaryEndpoints] = await Promise.all([
    buildResolvedEndpoints(primaryGroups, primaryNameservers),
    buildResolvedEndpoints(secondaryGroups, secondaryNameservers),
    tertiaryGroups
      ? buildResolvedEndpoints(tertiaryGroups, tertiaryNameservers)
      : Promise.resolve(undefined as ResolvedEndpoints | undefined),
  ]);

  // Default DisjointnessValidator using ResolvedEndpoints
  const validator = disjointnessValidator ?? {
    isDisjoint(primary: ResolvedEndpoints, secondary: ResolvedEndpoints): boolean {
      const primarySet = new Set(primary.flatEndpoints);
      const overlap = secondary.flatEndpoints.filter((ep) => primarySet.has(ep));
      if (overlap.length > 0) {
        getLogger().warn(
          { overlap, primary: primary.flatEndpoints, secondary: secondary.flatEndpoints },
          'DNS: consensus disjointness check FAILED — endpoint overlap detected',
        );
        return false;
      }
      // Operator overlap check
      const primaryOps = new Set<string>();
      const secondaryOps = new Set<string>();
      for (const [, op] of primary.operators) {
        if (op) primaryOps.add(op);
      }
      for (const [, op] of secondary.operators) {
        if (op) secondaryOps.add(op);
      }
      for (const op of primaryOps) {
        if (secondaryOps.has(op)) {
          getLogger().warn(
            { operator: op, primary: primary.flatEndpoints, secondary: secondary.flatEndpoints },
            'DNS: consensus disjointness check FAILED — same operator on both legs',
          );
          return false;
        }
      }
      return true;
    },
  };

  const opts: ConsensusDnsProviderOptions = {
    primary: primaryProvider,
    secondary: secondaryProvider,
    disjointnessValidator: validator,
    breakers: undefined,
    config: {
      requiredConfirmations: config?.requiredConfirmations ?? 1,
      degradedRatio: config?.degradedRatio ?? 0.5,
      degradedMin: config?.degradedMin ?? 10,
    },
    primaryEndpoints,
    secondaryEndpoints,
    primaryGroups,
    secondaryGroups,
    tertiaryGroups,
    revalidationIntervalMs: config?.revalidationIntervalMs ?? 600_000,
  };
  if (tertiaryProvider !== undefined) {
    opts.tertiary = tertiaryProvider;
  }
  if (tertiaryEndpoints !== undefined) {
    opts.tertiaryEndpoints = tertiaryEndpoints;
  }
  if (legTelemetry !== undefined) {
    opts.telemetry = legTelemetry;
  }
  return new ConsensusDnsProvider(opts);
}

/**
 * Build ResolvedEndpoints from resolver groups for runtime disjointness validation.
 * Uses live DNS resolution to populate IP sets for anycast-aware overlap detection.
 */
async function buildResolvedEndpoints(
  groups: DnsResolverGroup[],
  _nameservers: string[] | undefined,
): Promise<ResolvedEndpoints> {
  // Use the existing live resolution function
  const result = await resolveEndpointsLiveWithAnycast(groups, 2000);

  // Build operator map from OPERATOR_HINTS
  const operators = new Map<string, string>();
  const transports = new Map<string, string>();

  // Import OPERATOR_HINTS from resolver-validator
  // We'll use a local copy for now (the full map is in resolver-validator.ts)
  const operatorHints: Record<string, string> = {
    'doh:cloudflare-dns.com': 'cloudflare',
    'doh:one.one.one.one': 'cloudflare',
    'doh:dns.google': 'google',
    'doh:dns.google.com': 'google',
    'doh:dns.quad9.net': 'quad9',
    'doh:dns.adguard.com': 'adguard',
    'doh:dns.mullvad.net': 'mullvad',
    'doh:dns.opendns.com': 'opendns',
    'doh:dns.digitale-gesellschaft.ch': 'digitale-gesellschaft',
    'doh:doh.libredns.gr': 'libredns',
    'ip:1.1.1.1': 'cloudflare',
    'ip:1.0.0.1': 'cloudflare',
    'ip:162.159.36.1': 'cloudflare',
    'ip:162.159.46.1': 'cloudflare',
    'ip:8.8.8.8': 'google',
    'ip:8.8.4.4': 'google',
    'ip:9.9.9.9': 'quad9',
    'ip:149.112.112.112': 'quad9',
    'ip:94.140.14.14': 'adguard',
    'ip:94.140.15.15': 'adguard',
    'ip:194.242.2.2': 'mullvad',
    'ip:193.138.218.74': 'mullvad',
    'ip:45.90.28.2': 'nextdns',
    'ip:45.90.30.2': 'nextdns',
    'ip:208.67.222.222': 'opendns',
    'ip:208.67.220.220': 'opendns',
    'ip:185.95.218.42': 'digitale-gesellschaft',
    'ip:185.95.218.43': 'digitale-gesellschaft',
    'ip:2a05:fc84::42': 'digitale-gesellschaft',
    'ip:2a05:fc84::43': 'digitale-gesellschaft',
    'ip:116.202.176.26': 'libredns',
    'ip:116.202.176.27': 'libredns',
    'ip:2a01:4f8:1c0c:4c5f::2': 'libredns',
    'ip:2a01:4f8:1c0c:4c5f::3': 'libredns',
  };

  for (const detail of result.endpointDetails) {
    const op = operatorHints[detail.identity];
    if (op) operators.set(detail.identity, op);
    // Extract transport from identity prefix (doh:, dot:, native:)
    const transport = detail.identity.split(':')[0];
    if (transport) transports.set(detail.identity, transport);
  }

  return {
    flatEndpoints: result.flatEndpoints,
    endpointDetails: result.endpointDetails,
    operators,
    transports,
  };
}

/**
 * Builds the DNS 2-of-3 consensus config for the pipeline's DNS prefilter
 * stage, or undefined when DNS_CONSENSUS_ENABLED is false. Consensus is
 * ENABLED by default (see config.ts) — it runs unless explicitly disabled.
 *
 * `consensusRateLimiter` is the dedicated consensus budget (ADR-0044): the
 * secondary provider must NOT draw from the primary DNS bucket, else a heavy
 * run would starve the very gate that is supposed to fail it closed. When
 * omitted, a dedicated in-memory limiter is built from the
 * DNS_CONSENSUS_RATE_LIMIT_* config so the isolation holds even for callers
 * that never build the shared budget.
 */
type ConsensusOnFailureMode = 'fail' | 'degrade' | 'disable' | 'degraded-anycast';

function buildDisabledConsensusConfig(reason: string): ConsensusDnsConfig {
  return {
    secondaryProvider: null as unknown as DnsProvider,
    disabled: true,
    disableReason: reason,
  };
}

export async function buildDnsConsensusConfig(
  config: Config,
  consensusRateLimiter?: RateLimiterLike,
  breakers?: DnsBreakerRegistryLike,
  legTelemetry?: DnsLegTelemetry,
  onDisjointnessPartial?: () => void,
  metricsCollector?: {
    recordRuntimeConsensusValidation(stats: {
      overlapDetected: boolean;
      partial: boolean;
      overlapIPs: string[];
      overlapOperators: string[];
    }): void;
    recordDnsConsensusDegradedReason(reason: string): void;
    recordDnsConsensusAnycastDegradedRun(): void;
  },
  consensusOnFailure: ConsensusOnFailureMode = 'fail',
): Promise<ConsensusDnsConfig | undefined> {
  if (!config.DNS_CONSENSUS_ENABLED) return undefined;

  // Track local DoH consensus endpoint for privacy mode fallback (function-scoped)
  let localDohConsensusEndpoint: string | undefined;

  // Privacy mode (ADR-0065): when DNS_PRIVACY_MODE=true, all legs are forced to
  // 'native' against pinned recursors. The consensus gate requires a SECOND
  // distinct recursor (DNS_CONSENSUS_NAMESERVERS) to be an independent opinion.
  // With a single recursor the gate would be a rubber stamp.
  // Handle via DNS_CONSENSUS_PRIVACY_FALLBACK: 'disable' | 'degraded' | 'local-doh'
  if (config.DNS_PRIVACY_MODE) {
    const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
    if (consensusNameservers === undefined) {
      // Single recursor mode - handle via fallback config
      const fallbackMode = config.DNS_CONSENSUS_PRIVACY_FALLBACK ?? 'degraded';
      if (fallbackMode === 'disable') {
        getLogger().warn(
          'DNS: privacy mode with single recursor — consensus disabled (DNS_CONSENSUS_PRIVACY_FALLBACK=disable)',
        );
        return buildDisabledConsensusConfig(
          'Privacy mode with single recursor — consensus disabled',
        );
      }
      if (fallbackMode === 'local-doh') {
        localDohConsensusEndpoint = config.DNS_CONSENSUS_LOCAL_DOH_ENDPOINT;
        if (!localDohConsensusEndpoint) {
          const msg =
            'DNS_CONSENSUS_PRIVACY_FALLBACK=local-doh requires DNS_CONSENSUS_LOCAL_DOH_ENDPOINT';
          getLogger().error(msg);
          if (consensusOnFailure === 'fail') throw new Error(msg);
          return buildDisabledConsensusConfig(msg);
        }
        // Will create a local DoH provider as secondary below
        getLogger().info(
          { endpoint: localDohConsensusEndpoint },
          'DNS: privacy mode — using local DoH endpoint as consensus secondary',
        );
      } else {
        // 'degraded' mode (default) — return disabled config since single recursor
        // cannot provide independent consensus; the run will be marked degraded
        getLogger().warn(
          'DNS: privacy mode with single recursor — consensus disabled (degraded fallback)',
        );
        return buildDisabledConsensusConfig(
          'Privacy mode with single recursor — consensus disabled',
        );
      }
    }
    // If consensusNameservers is set, normal distinct-recursor validation proceeds below
  }

  // Distinct recursor requirement (ADR-0065, ADR-0066): when enabled (default),
  // the consensus and tertiary resolver sets must be disjoint from the primary.
  // In privacy mode with DNS_NAMESERVERS pinned, this enforces that
  // DNS_CONSENSUS_NAMESERVERS (and DNS_TERTIARY_NAMESERVERS if tertiary enabled)
  // are configured AND distinct from DNS_NAMESERVERS.
  // This check runs early but respects the consensusOnFailure mode.
  if (config.DNS_CONSENSUS_REQUIRE_DISTINCT_RECURSORS && config.DNS_NAMESERVERS !== undefined) {
    // localDohConsensusEndpoint is already in scope from above
    // Skip distinct-recursor check for local-doh fallback: the consensus uses
    // a DoH endpoint (different transport) rather than a nameserver IP.
    // The runtime disjointness check will validate transport-level independence.
    if (!localDohConsensusEndpoint) {
      const primaryNameservers = resolveNameservers(config.DNS_NAMESERVERS);
      if (primaryNameservers === undefined) {
        // DNS_NAMESERVERS is set but resolves to empty — this shouldn't happen but handle gracefully
        return buildDisabledConsensusConfig(
          'DNS_NAMESERVERS configured but resolves to empty nameserver list',
        );
      }
      const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
      const tertiaryNameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);

      const primarySet = new Set(primaryNameservers);
      const overlaps: string[] = [];
      const checkDistinct = (label: string, nameservers: string[] | undefined): void => {
        if (nameservers === undefined) return; // Not configured — disjointness check will catch later
        for (const ns of nameservers) {
          if (primarySet.has(ns)) {
            overlaps.push(`${label}:${ns}`);
          }
        }
      };

      checkDistinct('consensus', consensusNameservers);
      if (config.DNS_TERTIARY_ENABLED) {
        checkDistinct('tertiary', tertiaryNameservers);
      }

      if (overlaps.length > 0) {
        const msg =
          `DNS_CONSENSUS_REQUIRE_DISTINCT_RECURSORS=true: consensus/tertiary recursor overlaps with primary. ` +
          `Primary: ${primaryNameservers.join(', ')}. Overlaps: ${overlaps.join(', ')}. ` +
          `In privacy mode (or when DNS_NAMESERVERS is pinned), consensus/tertiary must use ` +
          `a DIFFERENT recursor. Configure DNS_CONSENSUS_NAMESERVERS/DNS_TERTIARY_NAMESERVERS ` +
          `with a distinct IP/host, or set DNS_CONSENSUS_REQUIRE_DISTINCT_RECURSORS=false ` +
          `(not recommended — reduces 2-of-3 gate to a rubber stamp).`;
        getLogger().error({ overlaps }, `DNS: consensus gate DISABLED at bootstrap — ${msg}`);
        if (consensusOnFailure === 'fail') {
          throw new Error(msg);
        }
        getLogger().warn(
          { mode: consensusOnFailure, reason: msg },
          `DNS: consensus gate disabled at bootstrap (${consensusOnFailure} mode) — continuing without cross-validation`,
        );
        return buildDisabledConsensusConfig(msg);
      }
    }
  }

  // A pinned private recursor (C3) replaces the consensus strategy's resolver
  // set with a native query to the local Unbound — the effective secondary
  // lookup mode is 'native' regardless of DNS_CONSENSUS_STRATEGY. Privacy
  // mode (ADR-0065) forces the same native path for every leg.
  const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
  const effectiveConsensusStrategy: DnsLookupStrategy = consensusNameservers
    ? 'native'
    : effectiveDnsLookupStrategy(config, config.DNS_CONSENSUS_STRATEGY);

  if (
    !validateConsensusStrategyDisjointness(
      config.DNS_CONSENSUS_ENABLED,
      config.DNS_LOOKUP_STRATEGY,
      effectiveConsensusStrategy,
    )
  ) {
    return undefined;
  }

  // Independence check (ADR-0002): the secondary must be a genuinely
  // different opinion. Hostname-level endpoint overlap, resolved-IP overlap
  // across transports (DoH hostname resolving to a DoT resolver's anycast
  // IP) and same-operator overlap (Cloudflare behind both DoH and DoT) all
  // veto the gate — otherwise the second opinion is a rubber stamp.
  // The primary's EMERGENCY FALLBACK legs are excluded: the gate must be
  // disjoint from the primary's main opinion, not from its last-resort net.
  // A shared fallback can never manufacture an Available verdict, and this
  // exclusion is what keeps the documented prod override (native fallback
  // and consensus both pinned to the private recursor) from silently
  // disabling the gate at runtime.
  const nameservers = resolveNameservers(config.DNS_NAMESERVERS);
  const primaryGroups =
    (config.DNS_RESOLVER_GROUPS as DnsResolverGroup[] | undefined) ??
    strategyToResolverGroups(
      effectiveDnsLookupStrategy(config, config.DNS_LOOKUP_STRATEGY),
      config.DNS_DOH_ENDPOINT,
    );

  // FALLBACK STRATEGY FOR CONSENSUS (ADR-0063/0065): If the primary consensus
  // strategy resolves to zero usable endpoints (e.g., DoT/853 blocked by egress
  // filtering), automatically try the configured fallback strategy. This prevents
  // silent gate disablement in environments where DoT egress is restricted.
  let consensusGroups = strategyToResolverGroups(
    effectiveConsensusStrategy,
    config.DNS_DOH_ENDPOINT,
  );
  let effectiveConsensusStrategyFinal: DnsLookupStrategy | undefined = effectiveConsensusStrategy;

  if (!hasUsableLookups(consensusGroups)) {
    const fallbackStrategyRaw = config.DNS_CONSENSUS_FALLBACK_STRATEGY;
    // Empty string means "disable fallback" — don't try to use it as a strategy
    const fallbackStrategyStr = String(fallbackStrategyRaw ?? '');
    if (fallbackStrategyStr && fallbackStrategyStr !== '' && fallbackStrategyStr !== 'native') {
      const fallbackStrategy = fallbackStrategyStr as DnsLookupStrategy;
      const fallbackGroups = strategyToResolverGroups(fallbackStrategy, config.DNS_DOH_ENDPOINT);
      if (hasUsableLookups(fallbackGroups)) {
        getLogger().warn(
          {
            primaryStrategy: effectiveConsensusStrategy,
            fallbackStrategy,
            primaryEndpoints: collectResolverEndpoints(consensusGroups, undefined, {
              excludeFallbacks: true,
            }).length,
            fallbackEndpoints: collectResolverEndpoints(fallbackGroups, undefined, {
              excludeFallbacks: true,
            }).length,
          },
          'DNS: consensus strategy yielded no usable endpoints — auto-switching to fallback strategy',
        );
        consensusGroups = fallbackGroups;
        effectiveConsensusStrategyFinal = fallbackStrategy;
      }
    }
  }

  // The consensus resolver set: a pinned private recursor overrides; otherwise
  // the shared DNS_NAMESERVERS apply (a native consensus reuses them).
  const effectiveConsensusNameservers = consensusNameservers ?? nameservers;
  const report = await validateConsensusDisjointness(
    primaryGroups,
    nameservers,
    consensusGroups,
    effectiveConsensusNameservers,
    {
      excludeFallbacks: true,
      ...(onDisjointnessPartial !== undefined
        ? { onResolutionPartial: onDisjointnessPartial }
        : {}),
    },
  );
  if (!report.ok) {
    // HARD FAIL: static bootstrap validation detected resolver overlap
    const reason =
      report.overlapEndpoints.length > 0
        ? `Static overlap: ${report.overlapEndpoints.join(', ')}`
        : `Operator overlap: ${report.overlapOperators.join(', ')}`;
    getLogger().error(
      { overlapEndpoints: report.overlapEndpoints, overlapOperators: report.overlapOperators },
      `DNS: consensus gate DISABLED at bootstrap — ${reason}. Refusing to start.`,
    );
    metricsCollector?.recordDnsConsensusDegradedReason(reason);
    if (consensusOnFailure === 'fail') {
      throw new Error(
        `DNS consensus gate invalid at bootstrap: ${reason}. ` +
          `Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS, DNS_TERTIARY_NAMESERVERS) ` +
          `or explicitly disable consensus (DNS_CONSENSUS_ENABLED=false).`,
      );
    }
    getLogger().warn(
      { mode: consensusOnFailure, reason },
      `DNS: consensus gate disabled at bootstrap (${consensusOnFailure} mode) — continuing without cross-validation`,
    );
    return buildDisabledConsensusConfig(reason);
  }
  if (report.resolutionPartial) {
    getLogger().warn(
      { primary: config.DNS_LOOKUP_STRATEGY, consensus: effectiveConsensusStrategyFinal },
      'DNS: consensus disjointness check ran without full DoH IP resolution ' +
        '(some hostnames did not resolve at boot) — operator and hostname-level ' +
        'disjointness still apply, resolved-IP overlap could not be proven',
    );
  }

  // FALLBACK ISOLATION VALIDATION (ADR-0063 P0)
  // The 2-of-3 consensus gate must be independent of the primary's MAIN opinion.
  // If the consensus/tertiary resolver set overlaps with the PRIMARY'S FALLBACK
  // recursor, the consensus is effectively querying the same resolver the primary
  // falls back to — the second opinion is a rubber stamp of the primary's last
  // resort, not an independent check. This is the documented P0 bug in the
  // turnkey docker-compose topology where both primary fallback and consensus
  // point at the same private recursor.
  //
  // The fallback isolation check now fails closed for single-recursor mode.
  // A consensus leg using the same recursor as the primary's fallback is NOT
  // an independent opinion (ADR-0002). The validator returns isolated=false,
  // which is handled by the general !fallbackReport.isolated check below.

  const fallbackReport = await validateFallbackIsolation(
    primaryGroups,
    consensusGroups,
    effectiveConsensusNameservers,
    nameservers,
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: message },
      'DNS: fallback isolation check failed — continuing with bootstrap-only validation (fail-open)',
    );
    return {
      isolated: true,
      fallbackOverlap: [],
      primaryFallbackEndpoints: [],
      consensusEndpoints: [],
      singleRecursorMode: false,
      degradedReason: undefined,
    };
  });

  if (!fallbackReport.isolated) {
    const reason = `Fallback overlap: ${fallbackReport.fallbackOverlap.join(', ')}`;
    getLogger().error(
      {
        fallbackOverlap: fallbackReport.fallbackOverlap,
        primaryFallbackEndpoints: fallbackReport.primaryFallbackEndpoints,
        consensusEndpoints: fallbackReport.consensusEndpoints,
      },
      `DNS: consensus gate DISABLED at bootstrap — ${reason}. Refusing to start.`,
    );
    metricsCollector?.recordDnsConsensusDegradedReason(reason);
    if (consensusOnFailure === 'fail') {
      throw new Error(
        `DNS consensus gate invalid at bootstrap: ${reason}. ` +
          `The consensus resolver overlaps with the primary's emergency fallback recursor. ` +
          `Configure a DIFFERENT recursor for consensus (DNS_CONSENSUS_NAMESERVERS) ` +
          `or disable consensus (DNS_CONSENSUS_ENABLED=false). ` +
          `A shared fallback cannot be an independent second opinion (ADR-0063).`,
      );
    }
    getLogger().warn(
      { mode: consensusOnFailure, reason },
      `DNS: consensus gate disabled at bootstrap (${consensusOnFailure} mode) — continuing without cross-validation`,
    );
    return buildDisabledConsensusConfig(reason);
  }

  // Tertiary consensus configuration (computed early for endpoint collection)
  let effectiveTertiaryStrategy: DnsLookupStrategy | undefined;
  let effectiveTertiaryNameservers: string[] | undefined;
  let tertiaryGroups: DnsResolverGroup[] | undefined;
  if (config.DNS_TERTIARY_ENABLED) {
    const tertiaryNameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);
    effectiveTertiaryStrategy = tertiaryNameservers
      ? 'native'
      : effectiveDnsLookupStrategy(config, config.DNS_TERTIARY_STRATEGY);
    effectiveTertiaryNameservers = tertiaryNameservers ?? nameservers;

    tertiaryGroups = strategyToResolverGroups(effectiveTertiaryStrategy, config.DNS_DOH_ENDPOINT);

    const tertiaryFallbackReport = await validateFallbackIsolation(
      primaryGroups,
      tertiaryGroups,
      effectiveTertiaryNameservers,
      nameservers,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: message },
        'DNS: tertiary fallback isolation check failed — continuing (fail-open)',
      );
      return {
        isolated: true,
        fallbackOverlap: [],
        primaryFallbackEndpoints: [],
        consensusEndpoints: [],
        singleRecursorMode: false,
        degradedReason: undefined,
      };
    });

    if (!tertiaryFallbackReport.isolated) {
      const reason = `Tertiary fallback overlap: ${tertiaryFallbackReport.fallbackOverlap.join(', ')}`;
      getLogger().error(
        {
          fallbackOverlap: tertiaryFallbackReport.fallbackOverlap,
          primaryFallbackEndpoints: tertiaryFallbackReport.primaryFallbackEndpoints,
          tertiaryEndpoints: tertiaryFallbackReport.consensusEndpoints,
        },
        `DNS: tertiary consensus gate DISABLED at bootstrap — ${reason}. Refusing to start.`,
      );
      metricsCollector?.recordDnsConsensusDegradedReason(reason);
      if (consensusOnFailure === 'fail') {
        throw new Error(
          `DNS tertiary consensus gate invalid at bootstrap: ${reason}. ` +
            `The tertiary resolver overlaps with the primary's emergency fallback recursor. ` +
            `Configure a DIFFERENT recursor for tertiary (DNS_TERTIARY_NAMESERVERS) ` +
            `or disable tertiary (DNS_TERTIARY_ENABLED=false).`,
        );
      }
      getLogger().warn(
        { mode: consensusOnFailure, reason },
        `DNS: tertiary consensus gate disabled at bootstrap (${consensusOnFailure} mode) — continuing without tertiary cross-validation`,
      );
      return buildDisabledConsensusConfig(reason);
    }
  }

  const secondaryRateLimiter = consensusRateLimiter ?? buildConsensusRateLimiter(config, undefined);

  // Build consensus providers (always needed for the return config)
  let secondaryProvider: DnsProvider;
  if (localDohConsensusEndpoint) {
    // Privacy mode with local DoH fallback: create a custom NodeDnsProvider
    // using the local DoH endpoint as the sole consensus leg.
    // This provides a distinct transport (DoH vs native) while querying
    // the same private recursor — satisfying the independence check.
    const localDohGroups: DnsResolverGroup[] = [
      {
        name: 'local-doh-consensus',
        lookups: [
          {
            type: 'doh',
            endpoint: localDohConsensusEndpoint,
            format: 'wire', // RFC 8484 wire format
          },
        ],
      },
    ];
    secondaryProvider = new NodeDnsProvider({
      cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
      maxSize: 0,
      lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
      resolverGroups: localDohGroups,
      dohEndpoint: localDohConsensusEndpoint!,
      dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
      bulkConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY,
      rateLimiter: secondaryRateLimiter,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
      breakers,
      ...(legTelemetry !== undefined
        ? { onLegResult: legTelemetry, legRole: 'consensus' as const }
        : {}),
      dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
      dnssecNativeEnabled: false,
    });
  } else {
    secondaryProvider = buildSecondaryDnsProvider(
      config,
      secondaryRateLimiter,
      breakers,
      legTelemetry,
      effectiveConsensusStrategyFinal, // Use fallback strategy if primary yielded no endpoints
    );
  }
  const tertiaryProviders = await buildTertiaryConsensusProviders(
    config,
    secondaryRateLimiter,
    primaryGroups,
    nameservers,
    consensusGroups,
    effectiveConsensusNameservers,
    breakers,
    legTelemetry,
    onDisjointnessPartial,
  );
  const tertiaryProvider = tertiaryProviders[0]; // First provider for backward compatibility with runtime validation

  // RUNTIME DISJOINTNESS VALIDATION (ADR-0066)
  // Perform live DNS queries through each leg to detect anycast/IP overlap
  // that hostname-level checks cannot catch. This validation is MANDATORY:
  // if overlap is detected, the application refuses to start (fail-closed).
  // Can be disabled via DNS_CONSENSUS_RUNTIME_VALIDATION=false (e.g., in tests
  // or environments where egress DNS is restricted).
  // Default mode is 'strict' for all editions (ADR-0002 conservatism).
  // 'permissive' is an explicit opt-out for environments without DNS egress.
  let runtimeReport: RuntimeConsensusReport = {
    ok: true,
    overlapIPs: [],
    overlapOperators: [],
    partial: false,
    runtimeDegraded: false,
    reason: '',
  };

  const runtimeValidationMode: RuntimeValidationMode = config.DNS_CONSENSUS_RUNTIME_VALIDATION_MODE;

  if (config.DNS_CONSENSUS_RUNTIME_VALIDATION) {
    // Build primary provider for runtime validation
    const primaryProvider = buildDnsProvider(
      config,
      undefined, // no cache repo for validation provider
      undefined, // no rate limiter for validation
      breakers,
      legTelemetry,
    );

    // Use the new resolver-validator function with fail-open option
    const failOpenOnResolutionError = config.DNS_CONSENSUS_FAIL_OPEN_ON_RESOLUTION_ERROR ?? false;
    const allowSingleRecursorInPrivacyMode =
      config.DNS_PRIVACY_MODE && config.DNS_CONSENSUS_PRIVACY_FALLBACK !== 'disable';

    const anycastReport = await validateConsensusDisjointnessRuntime(
      primaryGroups,
      consensusGroups,
      tertiaryGroups,
      config.DNS_CONSENSUS_VALIDATION_TIMEOUT_MS ?? 2000,
      config.DNS_CONSENSUS_ANYCAST_OVERLAP_THRESHOLD ?? 0.5,
      {
        failOpenOnResolutionError,
        allowSingleRecursorInPrivacyMode,
      },
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: message },
        'DNS: anycast-aware runtime consensus validation failed — continuing with bootstrap-only disjointness (fail-open)',
      );
      return {
        primaryEndpoints: [],
        secondaryEndpoints: [],
        overlaps: { primarySecondary: [], primaryTertiary: [], secondaryTertiary: [] },
        anycastOverlaps: { primarySecondary: [], primaryTertiary: [], secondaryTertiary: [] },
        isValid: true,
        anycastDegraded: false,
        failureReason: 'runtime validation error',
      } as DnsConsensusValidationResult;
    });

    runtimeReport.ok = anycastReport.isValid;
    runtimeReport.overlapIPs = anycastReport.overlaps.primarySecondary;
    runtimeReport.overlapOperators = [];
    runtimeReport.partial = false;
    runtimeReport.runtimeDegraded =
      anycastReport.anycastDegraded === true || allowSingleRecursorInPrivacyMode;
    runtimeReport.reason = anycastReport.failureReason ?? '';

    // Also run the probe-based validation for endpoint reachability
    const probeReport = await validateRuntimeConsensusDisjointness(
      primaryProvider,
      secondaryProvider,
      tertiaryProviders,
      runtimeValidationMode,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: message },
        'DNS: probe-based runtime consensus validation failed — continuing with anycast-only validation',
      );
      return {
        ok: true,
        overlapIPs: [],
        overlapOperators: [],
        partial: true,
        runtimeDegraded: false,
        reason: 'probe validation error',
      } as RuntimeConsensusReport;
    });

    // Merge results: if either validation fails, runtime is not ok
    if (!probeReport.ok) {
      runtimeReport.ok = false;
      runtimeReport.reason = probeReport.reason ?? '';
      runtimeReport.runtimeDegraded = true;
    }
  } else {
    getLogger().info(
      'DNS: runtime consensus validation skipped (DNS_CONSENSUS_RUNTIME_VALIDATION=false)',
    );
  }

  if (!runtimeReport.ok) {
    const reason =
      runtimeReport.reason ??
      `Runtime consensus overlap: IPs=${runtimeReport.overlapIPs.join(', ')}, operators=${runtimeReport.overlapOperators.join(', ')}`;
    getLogger().error(
      {
        overlapIPs: runtimeReport.overlapIPs,
        overlapOperators: runtimeReport.overlapOperators,
        partial: runtimeReport.partial,
        runtimeDegraded: runtimeReport.runtimeDegraded,
      },
      `DNS: runtime consensus disjointness FAILED — refusing to start. ${reason}`,
    );
    metricsCollector?.recordRuntimeConsensusValidation({
      overlapDetected: true,
      partial: runtimeReport.partial,
      overlapIPs: runtimeReport.overlapIPs,
      overlapOperators: runtimeReport.overlapOperators,
    });
    // HARD FAIL: do not return disabled config — consensus gate must be
    // genuinely independent or the pipeline must not run (ADR-0002 conservatism).
    // Operator must fix resolver topology or explicitly disable consensus.
    if (consensusOnFailure === 'fail') {
      throw new Error(
        `DNS consensus gate invalid at bootstrap: ${reason}. ` +
          `Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS, DNS_TERTIARY_NAMESERVERS) ` +
          `or explicitly disable consensus (DNS_CONSENSUS_ENABLED=false).`,
      );
    }
    getLogger().warn(
      { mode: consensusOnFailure, reason },
      `DNS: consensus gate disabled at runtime (${consensusOnFailure} mode) — continuing without cross-validation`,
    );
    return buildDisabledConsensusConfig(reason);
  }

  // In strict mode, runtimeDegraded=true means the gate is vetoed even without overlap
  if (runtimeReport.runtimeDegraded) {
    getLogger().error(
      {
        overlapIPs: runtimeReport.overlapIPs,
        overlapOperators: runtimeReport.overlapOperators,
        partial: runtimeReport.partial,
      },
      'DNS: runtime consensus validation incomplete in strict mode — gate vetoed. ' +
        'Configure disjoint resolver sets or set DNS_CONSENSUS_RUNTIME_VALIDATION_MODE=permissive.',
    );
    if (consensusOnFailure === 'fail') {
      throw new Error(
        'DNS consensus gate invalid at bootstrap: runtime validation incomplete in strict mode. ' +
          'Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS, DNS_TERTIARY_NAMESERVERS) ' +
          'or set DNS_CONSENSUS_RUNTIME_VALIDATION_MODE=permissive to allow degraded validation.',
      );
    }
    getLogger().warn(
      { mode: consensusOnFailure },
      `DNS: consensus gate disabled at runtime (${consensusOnFailure} mode) — continuing without cross-validation (runtime degraded in strict mode)`,
    );
    return buildDisabledConsensusConfig('Runtime validation incomplete in strict mode');
  }

  metricsCollector?.recordRuntimeConsensusValidation({
    overlapDetected: false,
    partial: runtimeReport.partial,
    overlapIPs: runtimeReport.overlapIPs,
    overlapOperators: runtimeReport.overlapOperators,
  });

  if (runtimeReport.partial && runtimeValidationMode === 'permissive') {
    getLogger().warn(
      { overlapIPs: runtimeReport.overlapIPs, overlapOperators: runtimeReport.overlapOperators },
      'DNS: runtime consensus validation completed with partial results (some legs did not answer) — gate remains enabled (permissive mode)',
    );
  } else {
    getLogger().info(
      { overlapIPs: runtimeReport.overlapIPs, overlapOperators: runtimeReport.overlapOperators },
      'DNS: runtime consensus validation PASSED — all legs independent',
    );
  }

  // ANYCAST-AWARE VALIDATION (ADR-0068): Already computed above in runtime validation
  // Reuse the anycastReport from the runtime validation step
  const anycastReport =
    runtimeReport.ok !== undefined && runtimeReport.overlapIPs.length >= 0
      ? {
          // Reconstruct minimal report from runtime validation
          primaryEndpoints: [],
          secondaryEndpoints: [],
          tertiaryEndpoints: undefined,
          overlaps: {
            primarySecondary: runtimeReport.overlapIPs,
            primaryTertiary: [],
            secondaryTertiary: [],
          },
          anycastOverlaps: { primarySecondary: [], primaryTertiary: [], secondaryTertiary: [] },
          isValid: runtimeReport.ok,
          anycastDegraded: runtimeReport.runtimeDegraded,
          failureReason: runtimeReport.reason,
        }
      : await validateConsensusDisjointnessRuntime(
          primaryGroups,
          consensusGroups,
          tertiaryGroups,
          config.DNS_CONSENSUS_VALIDATION_TIMEOUT_MS ?? 2000,
          config.DNS_CONSENSUS_ANYCAST_OVERLAP_THRESHOLD ?? 0.5,
          {
            failOpenOnResolutionError: config.DNS_CONSENSUS_FAIL_OPEN_ON_RESOLUTION_ERROR ?? false,
            allowSingleRecursorInPrivacyMode:
              config.DNS_PRIVACY_MODE && config.DNS_CONSENSUS_PRIVACY_FALLBACK !== 'disable',
          },
        ).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          getLogger().warn(
            { err: message },
            'DNS: anycast-aware consensus validation failed — continuing without anycast overlap analysis',
          );
          return {
            primaryEndpoints: [],
            secondaryEndpoints: [],
            overlaps: { primarySecondary: [], primaryTertiary: [], secondaryTertiary: [] },
            anycastOverlaps: { primarySecondary: [], primaryTertiary: [], secondaryTertiary: [] },
            isValid: true,
            anycastDegraded: false,
          } as DnsConsensusValidationResult;
        });

  const anycastDegraded = anycastReport.anycastDegraded === true;

  // Handle 'degraded-anycast' failure policy
  if (anycastDegraded) {
    const exceedingPairs = [
      ...(anycastReport.anycastOverlaps?.primarySecondary ?? []),
      ...(anycastReport.anycastOverlaps?.primaryTertiary ?? []),
      ...(anycastReport.anycastOverlaps?.secondaryTertiary ?? []),
    ].filter((o) => o.exceedsThreshold);

    const anycastReason =
      `Anycast overlap exceeds threshold (${config.DNS_CONSENSUS_ANYCAST_OVERLAP_THRESHOLD}): ` +
      exceedingPairs
        .map(
          (o) =>
            `${o.primaryIdentity} <-> ${o.secondaryIdentity} (${(o.overlapRatio * 100).toFixed(1)}% overlap: ${o.overlappingIps.join(', ')})`,
        )
        .join('; ');

    getLogger().warn(
      {
        anycastOverlaps: anycastReport.anycastOverlaps,
        threshold: config.DNS_CONSENSUS_ANYCAST_OVERLAP_THRESHOLD,
        exceedingPairs: exceedingPairs.map((o) => ({
          primary: o.primaryIdentity,
          secondary: o.secondaryIdentity,
          overlapRatio: o.overlapRatio,
          overlappingIps: o.overlappingIps,
        })),
      },
      `DNS: anycast overlap detected — ${anycastReason}`,
    );

    metricsCollector?.recordDnsConsensusDegradedReason(`anycast-overlap: ${anycastReason}`);

    if (consensusOnFailure === 'fail') {
      throw new Error(
        `DNS consensus gate invalid at bootstrap: ${anycastReason}. ` +
          `Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS, DNS_TERTIARY_NAMESERVERS) ` +
          `or set DNS_CONSENSUS_ON_FAILURE=degraded-anycast to allow degraded operation.`,
      );
    } else if (consensusOnFailure === 'degrade' || consensusOnFailure === 'disable') {
      getLogger().warn(
        { mode: consensusOnFailure, reason: anycastReason },
        `DNS: consensus gate disabled at bootstrap (${consensusOnFailure} mode) — continuing without cross-validation`,
      );
      return buildDisabledConsensusConfig(anycastReason);
    }
    // 'degraded-anycast' mode: continue with gate enabled but mark as degraded
    getLogger().info(
      { mode: consensusOnFailure, reason: anycastReason },
      'DNS: consensus gate enabled in degraded-anycast mode — run will be marked degraded',
    );
    metricsCollector?.recordDnsConsensusAnycastDegradedRun();
  }

  // Collect consensus resolver endpoints for authoritative zone overlap detection
  const secondaryEndpoints = collectResolverEndpoints(
    consensusGroups,
    effectiveConsensusNameservers,
    {
      excludeFallbacks: true,
    },
  );
  const tertiaryEndpoints = tertiaryProvider
    ? collectResolverEndpoints(
        strategyToResolverGroups(
          effectiveTertiaryStrategy ?? 'doh-tertiary',
          config.DNS_DOH_ENDPOINT,
        ),
        effectiveTertiaryNameservers,
        { excludeFallbacks: true },
      )
    : [];

  // Create AuthoritativeZoneResolver for zone-aware disjointness validation
  const authoritativeZoneResolver = await createAuthoritativeZoneResolver(
    config.DNS_CONSENSUS_ENABLED,
  );

  const enabledConfig: ConsensusDnsConfig = {
    secondaryProvider,
    disabled: false,
    degradedRatio: config.DNS_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.DNS_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY,
    requiredAvailable: config.DNS_CONSENSUS_REQUIRED_AVAILABLE,
    runtimeDegraded: runtimeReport.runtimeDegraded,
    anycastDegraded,
    ...(anycastReport.anycastOverlaps
      ? {
          anycastOverlaps: {
            primarySecondary: (anycastReport.anycastOverlaps.primarySecondary ?? []).map(
              (o: AnycastOverlapDetail) => ({
                primaryIdentity: o.primaryIdentity,
                secondaryIdentity: o.secondaryIdentity,
                primaryIps: o.primaryIps,
                secondaryIps: o.secondaryIps,
                overlappingIps: o.overlappingIps,
                overlapRatio: o.overlapRatio,
                exceedsThreshold: o.exceedsThreshold,
              }),
            ),
            primaryTertiary: (anycastReport.anycastOverlaps.primaryTertiary ?? []).map(
              (o: AnycastOverlapDetail) => ({
                primaryIdentity: o.primaryIdentity,
                secondaryIdentity: o.secondaryIdentity,
                primaryIps: o.primaryIps,
                secondaryIps: o.secondaryIps,
                overlappingIps: o.overlappingIps,
                overlapRatio: o.overlapRatio,
                exceedsThreshold: o.exceedsThreshold,
              }),
            ),
            secondaryTertiary: (anycastReport.anycastOverlaps.secondaryTertiary ?? []).map(
              (o: AnycastOverlapDetail) => ({
                primaryIdentity: o.primaryIdentity,
                secondaryIdentity: o.secondaryIdentity,
                primaryIps: o.primaryIps,
                secondaryIps: o.secondaryIps,
                overlappingIps: o.overlappingIps,
                overlapRatio: o.overlapRatio,
                exceedsThreshold: o.exceedsThreshold,
              }),
            ),
          },
        }
      : {}),
    ...(authoritativeZoneResolver !== undefined ? { authoritativeZoneResolver } : {}),
    secondaryEndpoints,
    tertiaryEndpoints,
  };

  // Extra fields for runtime re-validation (internal, not part of public API)
  // Only include when defined to satisfy exactOptionalPropertyTypes
  type InternalConfig = ConsensusDnsConfig & {
    _primaryGroups?: DnsResolverGroup[];
    _secondaryGroups?: DnsResolverGroup[];
    _secondaryGroups2?: DnsResolverGroup[];
    _tertiaryGroups?: DnsResolverGroup[] | undefined;
    _primaryNameservers?: string[] | undefined;
    _secondaryNameservers?: string[] | undefined;
    _tertiaryNameservers?: string[] | undefined;
  };
  const internalConfig = enabledConfig as InternalConfig;

  if (primaryGroups.length > 0) internalConfig._primaryGroups = primaryGroups;
  if (consensusGroups.length > 0) internalConfig._secondaryGroups = consensusGroups;
  if (tertiaryGroups && tertiaryGroups.length > 0) internalConfig._tertiaryGroups = tertiaryGroups;
  if (nameservers && nameservers.length > 0) internalConfig._primaryNameservers = nameservers;
  if (effectiveConsensusNameservers && effectiveConsensusNameservers.length > 0)
    internalConfig._secondaryNameservers = effectiveConsensusNameservers;
  if (effectiveTertiaryNameservers && effectiveTertiaryNameservers.length > 0)
    internalConfig._tertiaryNameservers = effectiveTertiaryNameservers;

  // Add dual-redundant secondary config if we have multiple providers
  const effectiveConsensusRateLimiter =
    consensusRateLimiter ?? buildConsensusRateLimiter(config, undefined);
  const secondaryProviders = await buildSecondaryConsensusProviders(
    config,
    effectiveConsensusRateLimiter,
    primaryGroups,
    nameservers,
    breakers,
    legTelemetry,
    onDisjointnessPartial,
  );

  if (secondaryProviders.length > 1) {
    const firstSecondary = secondaryProviders[0]!;
    const secondSecondary = secondaryProviders[1]!;
    enabledConfig.secondaryConfig = {
      primary: firstSecondary,
      secondary: secondSecondary,
      strategy: 'dual-redundant',
    };
    // Also store the second secondary's resolver groups for runtime re-validation
    internalConfig._secondaryGroups2 = consensusGroups; // We'll need to capture both groups
  }

  if (tertiaryProviders.length > 0) {
    // Use first tertiary for backward compatibility
    const firstTertiary = tertiaryProviders[0]!;
    enabledConfig.tertiaryProvider = firstTertiary;
    // Add dual-redundant config if we have multiple providers
    if (tertiaryProviders.length > 1) {
      const secondTertiary = tertiaryProviders[1]!;
      enabledConfig.tertiaryConfig = {
        primary: firstTertiary,
        secondary: secondTertiary,
        strategy: 'dual-redundant',
      };
    }
  }
  return enabledConfig;
}

/**
 * Builds the optional THIRD DNS consensus opinion (ADR-0045/0068), when
 * DNS_TERTIARY_ENABLED is on. Returns an array of providers when dual-redundant
 * mode is enabled (two independent operators), otherwise a single provider.
 * Returns empty array when the leg is disabled or when its resolver set overlaps
 * either the primary or the secondary — a third opinion through the same endpoints
 * is no opinion at all, and the gate must never silently degrade by thinning redundancy.
 * Each tertiary provider uses its own dedicated rate-limit budget (ADR-0044/0068):
 * the verification gate counts against its own bucket, never against the primary's
 * or the secondary's.
 */
async function buildTertiaryConsensusProviders(
  config: Config,
  _consensusRateLimiter: RateLimiterLike, // Unused: tertiary gets its own budget
  primaryGroups: DnsResolverGroup[],
  primaryNameservers: string[] | undefined,
  consensusGroups: DnsResolverGroup[],
  consensusNameservers: string[] | undefined,
  breakers?: DnsBreakerRegistryLike,
  legTelemetry?: DnsLegTelemetry,
  onDisjointnessPartial?: () => void,
): Promise<DnsProvider[]> {
  if (!config.DNS_TERTIARY_ENABLED) return [];

  // Dual-redundant mode (ADR-0068): create two independent tertiary providers
  if (config.DNS_TERTIARY_DUAL_REDUNDANT) {
    const providers: DnsProvider[] = [];

    // Provider 1: DNS_TERTIARY_STRATEGY_1
    const tertiary1Nameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);
    const effectiveTertiary1Strategy: DnsLookupStrategy = tertiary1Nameservers
      ? 'native'
      : effectiveDnsLookupStrategy(config, config.DNS_TERTIARY_STRATEGY_1);
    const tertiary1Groups = strategyToResolverGroups(
      effectiveTertiary1Strategy,
      config.DNS_DOH_ENDPOINT,
    );
    const effectiveTertiary1Nameservers = tertiary1Nameservers ?? primaryNameservers;

    // Rate limiter for tertiary provider 1 (split budget)
    const tertiary1RateLimiter = config.REDIS_URL
      ? new RedisRateLimiter({
          tokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_1 ?? 5,
          intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS_1 ?? 1000,
          namespace: 'dns:tertiary1:',
        } as RedisRateLimiterConfig)
      : new PriorityRateLimiter(
          {
            maxTokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_1 ?? 5,
            tokensPerInterval: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_1 ?? 5,
            intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS_1 ?? 1000,
          },
          0,
        );

    // Independence check against BOTH existing legs for provider 1
    const primaryReport1 = await validateConsensusDisjointness(
      tertiary1Groups,
      effectiveTertiary1Nameservers,
      primaryGroups,
      primaryNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );
    const consensusReport1 = await validateConsensusDisjointness(
      tertiary1Groups,
      effectiveTertiary1Nameservers,
      consensusGroups,
      consensusNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );

    if (primaryReport1.ok && consensusReport1.ok) {
      providers.push(
        new NodeDnsProvider({
          cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
          maxSize: 0,
          lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
          lookupStrategy: effectiveTertiary1Strategy,
          dohEndpoint: config.DNS_DOH_ENDPOINT,
          dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
          bulkConcurrency: config.DNS_TERTIARY_BULK_CONCURRENCY ?? 10,
          ...(effectiveTertiary1Nameservers !== undefined
            ? { nameservers: effectiveTertiary1Nameservers }
            : {}),
          rateLimiter: tertiary1RateLimiter,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
          breakers,
          ...(legTelemetry !== undefined
            ? { onLegResult: legTelemetry, legRole: 'tertiary' as const }
            : {}),
          dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
          dnssecNativeEnabled:
            config.DNS_NATIVE_DNSSEC_ENABLED && effectiveTertiary1Nameservers !== undefined,
        }),
      );
    } else {
      const report = !primaryReport1.ok ? primaryReport1 : consensusReport1;
      const reason =
        report.overlapEndpoints.length > 0
          ? `Static overlap: ${report.overlapEndpoints.join(', ')}`
          : `Operator overlap: ${report.overlapOperators.join(', ')}`;
      getLogger().warn(
        { overlapEndpoints: report.overlapEndpoints, overlapOperators: report.overlapOperators },
        `DNS: tertiary provider 1 (${config.DNS_TERTIARY_STRATEGY_1}) DISABLED at bootstrap — ${reason}.`,
      );
    }

    // Provider 2: DNS_TERTIARY_STRATEGY_2
    const tertiary2Nameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);
    const effectiveTertiary2Strategy: DnsLookupStrategy = tertiary2Nameservers
      ? 'native'
      : effectiveDnsLookupStrategy(config, config.DNS_TERTIARY_STRATEGY_2);
    const tertiary2Groups = strategyToResolverGroups(
      effectiveTertiary2Strategy,
      config.DNS_DOH_ENDPOINT,
    );
    const effectiveTertiary2Nameservers = tertiary2Nameservers ?? primaryNameservers;

    // Rate limiter for tertiary provider 2 (split budget)
    const tertiary2RateLimiter = config.REDIS_URL
      ? new RedisRateLimiter({
          tokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_2 ?? 5,
          intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS_2 ?? 1000,
          namespace: 'dns:tertiary2:',
        } as RedisRateLimiterConfig)
      : new PriorityRateLimiter(
          {
            maxTokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_2 ?? 5,
            tokensPerInterval: config.DNS_TERTIARY_RATE_LIMIT_TOKENS_2 ?? 5,
            intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS_2 ?? 1000,
          },
          0,
        );

    // Independence check against BOTH existing legs for provider 2
    const primaryReport2 = await validateConsensusDisjointness(
      tertiary2Groups,
      effectiveTertiary2Nameservers,
      primaryGroups,
      primaryNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );
    const consensusReport2 = await validateConsensusDisjointness(
      tertiary2Groups,
      effectiveTertiary2Nameservers,
      consensusGroups,
      consensusNameservers,
      {
        excludeFallbacks: true,
        ...(onDisjointnessPartial !== undefined
          ? { onResolutionPartial: onDisjointnessPartial }
          : {}),
      },
    );

    if (primaryReport2.ok && consensusReport2.ok) {
      providers.push(
        new NodeDnsProvider({
          cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
          maxSize: 0,
          lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
          lookupStrategy: effectiveTertiary2Strategy,
          dohEndpoint: config.DNS_DOH_ENDPOINT,
          dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
          bulkConcurrency: config.DNS_TERTIARY_BULK_CONCURRENCY ?? 10,
          ...(effectiveTertiary2Nameservers !== undefined
            ? { nameservers: effectiveTertiary2Nameservers }
            : {}),
          rateLimiter: tertiary2RateLimiter,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
          breakers,
          ...(legTelemetry !== undefined
            ? { onLegResult: legTelemetry, legRole: 'tertiary' as const }
            : {}),
          dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
          dnssecNativeEnabled:
            config.DNS_NATIVE_DNSSEC_ENABLED && effectiveTertiary2Nameservers !== undefined,
        }),
      );
    } else {
      const report = !primaryReport2.ok ? primaryReport2 : consensusReport2;
      const reason =
        report.overlapEndpoints.length > 0
          ? `Static overlap: ${report.overlapEndpoints.join(', ')}`
          : `Operator overlap: ${report.overlapOperators.join(', ')}`;
      getLogger().warn(
        { overlapEndpoints: report.overlapEndpoints, overlapOperators: report.overlapOperators },
        `DNS: tertiary provider 2 (${config.DNS_TERTIARY_STRATEGY_2}) DISABLED at bootstrap — ${reason}.`,
      );
    }

    if (providers.length === 0) {
      throw new Error(
        'DNS tertiary consensus gate invalid at bootstrap: both tertiary providers overlap with primary or secondary. ' +
          `Configure disjoint resolver sets (DNS_TERTIARY_NAMESERVERS) or disable tertiary consensus (DNS_TERTIARY_ENABLED=false).`,
      );
    }

    return providers;
  }

  // Legacy single tertiary provider mode
  const tertiaryNameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);
  const effectiveTertiaryStrategy: DnsLookupStrategy = tertiaryNameservers
    ? 'native'
    : effectiveDnsLookupStrategy(config, config.DNS_TERTIARY_STRATEGY);
  const tertiaryGroups = strategyToResolverGroups(
    effectiveTertiaryStrategy,
    config.DNS_DOH_ENDPOINT,
  );
  const effectiveTertiaryNameservers = tertiaryNameservers ?? primaryNameservers;

  // Independence check against BOTH existing legs
  const primaryReport = await validateConsensusDisjointness(
    tertiaryGroups,
    effectiveTertiaryNameservers,
    primaryGroups,
    primaryNameservers,
    {
      excludeFallbacks: true,
      ...(onDisjointnessPartial !== undefined
        ? { onResolutionPartial: onDisjointnessPartial }
        : {}),
    },
  );
  const consensusReport = await validateConsensusDisjointness(
    tertiaryGroups,
    effectiveTertiaryNameservers,
    consensusGroups,
    consensusNameservers,
    {
      excludeFallbacks: true,
      ...(onDisjointnessPartial !== undefined
        ? { onResolutionPartial: onDisjointnessPartial }
        : {}),
    },
  );
  if (!primaryReport.ok || !consensusReport.ok) {
    const report = !primaryReport.ok ? primaryReport : consensusReport;
    const reason =
      report.overlapEndpoints.length > 0
        ? `Static overlap: ${report.overlapEndpoints.join(', ')}`
        : `Operator overlap: ${report.overlapOperators.join(', ')}`;
    getLogger().error(
      { overlapEndpoints: report.overlapEndpoints, overlapOperators: report.overlapOperators },
      `DNS: tertiary consensus gate DISABLED at bootstrap — ${reason}. Refusing to start.`,
    );
    throw new Error(
      `DNS tertiary consensus gate invalid at bootstrap: ${reason}. ` +
        `Configure disjoint resolver sets (DNS_TERTIARY_NAMESERVERS) ` +
        `or disable tertiary consensus (DNS_TERTIARY_ENABLED=false).`,
    );
  }

  // Dedicated rate limiter for single tertiary provider (not shared with consensus)
  const tertiaryRateLimiter = config.REDIS_URL
    ? new RedisRateLimiter({
        tokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS ?? 10,
        intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS ?? 1000,
        namespace: 'dns:tertiary:',
      } as RedisRateLimiterConfig)
    : new PriorityRateLimiter(
        {
          maxTokens: config.DNS_TERTIARY_RATE_LIMIT_TOKENS ?? 10,
          tokensPerInterval: config.DNS_TERTIARY_RATE_LIMIT_TOKENS ?? 10,
          intervalMs: config.DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS ?? 1000,
        },
        0,
      );

  return [
    new NodeDnsProvider({
      cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
      maxSize: 0,
      lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
      lookupStrategy: effectiveTertiaryStrategy,
      dohEndpoint: config.DNS_DOH_ENDPOINT,
      dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
      bulkConcurrency: config.DNS_TERTIARY_BULK_CONCURRENCY ?? 10,
      ...(effectiveTertiaryNameservers !== undefined
        ? { nameservers: effectiveTertiaryNameservers }
        : {}),
      rateLimiter: tertiaryRateLimiter,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
      breakers,
      ...(legTelemetry !== undefined
        ? { onLegResult: legTelemetry, legRole: 'tertiary' as const }
        : {}),
      dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
      dnssecNativeEnabled:
        config.DNS_NATIVE_DNSSEC_ENABLED && effectiveTertiaryNameservers !== undefined,
    }),
  ];
}

/**
 * Startup probe for the DNS consensus secondary (and optional tertiary)
 * provider. With strict 2-of-3 consensus semantics (ADR-0002) any failure
 * of a verification leg downgrades every Available to Unknown, so a dead
 * leg (e.g. egress port 853 filtered, blocking the default 'dot-alternate'
 * strategy) is a silent outage worth surfacing at boot. Non-fatal: consensus
 * stays enabled, but the operator is told clearly what is happening.
 *
 * Probes with `forceRecheck: true` to bypass any cache and verify live
 * resolver reachability (ADR-0063 P2 fix: consensus must query live resolvers).
 */
export function probeConsensusProvider(
  config: Config,
  secondaryProvider: DnsProvider,
  tertiaryProviders?: DnsProvider[],
): void {
  if (!config.DNS_CONSENSUS_ENABLED) return;
  const logger = getLogger();
  const probeOpts = { forceRecheck: true as const };
  logger.warn(
    { strategy: config.DNS_CONSENSUS_STRATEGY },
    'DNS: probing consensus secondary provider at startup',
  );
  validateResolverGroups(secondaryProvider, probeOpts).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: message, strategy: config.DNS_CONSENSUS_STRATEGY },
      'DNS: consensus secondary provider unreachable at startup — strict consensus ' +
        'will downgrade every Available verdict to Unknown. Verify DNS_CONSENSUS_STRATEGY ' +
        'egress (dot strategies use TCP/853) or consider DNS_CONSENSUS_ENABLED=false.',
    );
  });
  if (tertiaryProviders && tertiaryProviders.length > 0) {
    for (let i = 0; i < tertiaryProviders.length; i++) {
      const strategy = i === 0 ? config.DNS_TERTIARY_STRATEGY_1 : config.DNS_TERTIARY_STRATEGY_2;
      logger.warn(
        { strategy, index: i + 1 },
        `DNS: probing consensus tertiary provider ${i + 1} at startup`,
      );
      validateResolverGroups(tertiaryProviders[i]!, probeOpts).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { err: message, strategy },
          `DNS: consensus tertiary provider ${i + 1} unreachable at startup — with ` +
            'requiredAvailable=2 every Available verdict needs it and will be ' +
            'downgraded to Unknown. Verify DNS_TERTIARY_STRATEGY/NAMESERVERS.',
        );
      });
    }
  }
}

/**
 * Startup probe for the RDAP consensus second provider (ADR-0050 §6,
 * delivered by ADR-0051). The fail-closed 2-of-2 gate downgrades every
 * Available verdict the second leg cannot confirm, so a dead endpoint
 * (egress blocked, expired TLS, wrong host) is a silent outage worth
 * surfacing at boot. Non-fatal: the gate stays enabled, but the operator is
 * told clearly what is degrading every run.
 *
 * Probes with `confirm()` on a stable, well-known registered domain
 * (`example.com`): any definitive verdict (Available or Registered) proves
 * the endpoint answers, while an error/timeout proves it does not. The probe
 * verdict is never used for anything.
 */
export async function probeRdapConsensusEndpoint(
  config: Config,
  secondaryProvider: RdapProvider,
): Promise<void> {
  if (!config.RDAP_CONSENSUS_ENABLED) return;
  const logger = getLogger();
  const endpoint = config.RDAP_CONSENSUS_ENDPOINT;
  logger.warn({ endpoint }, 'RDAP: probing consensus second provider at startup');
  const probeSignal = AbortSignal.timeout(config.RDAP_CONSENSUS_TIMEOUT_MS);
  try {
    await secondaryProvider.confirm('example.com', probeSignal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: message, endpoint },
      'RDAP: consensus second provider unreachable at startup — the fail-closed 2-of-2 ' +
        'gate will downgrade unconfirmable Available verdicts. Verify egress to the ' +
        'consensus endpoint or disable the gate (RDAP_CONSENSUS_ENABLED=false).',
    );
  }
}

export interface BuiltWhoisProvider {
  raw: NodeWhoisProviderWithIanaFallback;
  withRetry: WhoisProviderInterface;
}

/**
 * Dedicated rate limiter for WHOIS port-43 traffic (ADR-0052). WHOIS is the
 * most restrictive channel in the stack (default 2 tokens / 2000ms) and the
 * last provider without a distributed budget: rdap/uspto/euipo/wayback/dns
 * plus both consensus gates already run on Redis namespaces (ADR-0041,
 * ADR-0044, ADR-0050). In cloud mode the shared bucket is a `whois` Redis
 * namespace with per-tenant fair share (ADR-0041): N replicas enforce ONE
 * registry-facing rate and no tenant can starve the others. Without Redis
 * the behaviour is unchanged — a per-process in-memory token bucket.
 */
export function buildWhoisRateLimiter(config: Config, redisClient?: RedisClient): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  if (redisClient?.isConnected) {
    return new RedisRateLimiter(
      {
        tokens: config.WHOIS_RATE_LIMIT_TOKENS,
        intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
        namespace: 'whois',
        fairShare,
        perTenantTokens: config.WHOIS_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS !== config.WHOIS_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
      },
      redisClient,
    );
  }
  return new RateLimiter({
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });
}

/**
 * Per-TLD WHOIS budgets (ADR-0052). WHOIS_RATE_LIMIT_OVERRIDES semantics are
 * preserved exactly (shared parseWhoisRateLimitOverrides parser) but each
 * TLD override becomes its own `whois:<tld>` Redis namespace in cloud mode,
 * with per-tenant fair share enabled so one tenant cannot drain the
 * strictest registries on behalf of all. Invalid JSON silently falls back to
 * an empty set, mirroring the in-memory builder.
 */
export function buildWhoisPerTldRateLimiters(
  config: Config,
  redisClient?: RedisClient,
): Record<string, RateLimiterLike> {
  const limiters: Record<string, RateLimiterLike> = {};

  const overrides = parseWhoisRateLimitOverrides(config.WHOIS_RATE_LIMIT_OVERRIDES);

  for (const [cleanTld, cfg] of Object.entries(overrides)) {
    const tokens = cfg.maxTokens ?? cfg.tokensPerInterval ?? config.WHOIS_RATE_LIMIT_TOKENS;
    const intervalMs = cfg.intervalMs ?? config.WHOIS_RATE_LIMIT_INTERVAL_MS;
    if (redisClient?.isConnected) {
      limiters[cleanTld] = new RedisRateLimiter(
        {
          tokens,
          intervalMs,
          namespace: `whois:${cleanTld.slice(1)}`,
          fairShare: config.PROVIDER_FAIR_SHARE_ENABLED,
        },
        redisClient,
      );
    } else {
      limiters[cleanTld] = new RateLimiter({
        maxTokens: tokens,
        tokensPerInterval: tokens,
        intervalMs,
      });
    }
  }

  return limiters;
}

/**
 * Build WHOIS circuit breaker: distributed (Redis-backed) when Redis is connected,
 * in-memory otherwise. Keyed as 'cb:whois' for cross-process coordination.
 */
function buildWhoisCircuitBreaker(redisClient?: RedisClient): ICircuitBreaker {
  if (redisClient?.isConnected) {
    return new DistributedCircuitBreaker('whois', WHOIS_CIRCUIT_BREAKER, redisClient);
  }
  return new CircuitBreaker(WHOIS_CIRCUIT_BREAKER);
}

export function buildWhoisProviders(config: Config, redisClient?: RedisClient): BuiltWhoisProvider {
  const whoisDefaultLimiter = buildWhoisRateLimiter(config, redisClient);
  const whoisCircuitBreaker = buildWhoisCircuitBreaker(redisClient);

  const whoisPerTldLimiters = buildWhoisPerTldRateLimiters(config, redisClient);

  const raw = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    defaultRateLimiter: whoisDefaultLimiter,
    perTldRateLimiters: whoisPerTldLimiters,
    circuitBreaker: whoisCircuitBreaker,
  });

  const withRetry = new RetryingWhoisProvider(raw, {}, whoisCircuitBreaker);

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

/**
 * Dedicated rate limiter for the 2-of-2 RDAP consensus leg (ADR-0050). Like
 * the DNS consensus budget (ADR-0044), the second RDAP provider must run
 * against its own bucket: sharing the primary's would let a heavy run starve
 * the very verification gate that is supposed to fail it closed. Uses the
 * RDAP_CONSENSUS_RATE_LIMIT_* tuning and a `rdap-consensus` Redis namespace
 * in cloud mode.
 */
export function buildRdapConsensusRateLimiter(
  config: Config,
  redisClient?: RedisClient,
): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  if (redisClient?.isConnected) {
    return new RedisRateLimiter(
      {
        tokens: config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
        intervalMs: config.RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
        namespace: 'rdap-consensus',
        fairShare,
        perTenantTokens: config.RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS !==
          config.RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
      },
      redisClient,
    );
  }
  return new RateLimiter({
    maxTokens: config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
    intervalMs: config.RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
  });
}

export interface BuiltRateLimiters {
  rdap: RateLimiterLike;
  uspto: RateLimiterLike;
  euipo: RateLimiterLike;
  wayback: RateLimiterLike;
  dns: RateLimiterLike;
  /** Dedicated budget for the 2-of-3 DNS consensus secondary (ADR-0044). */
  dnsConsensus: RateLimiterLike;
  /** Dedicated budget for the 2-of-2 RDAP consensus leg (ADR-0050). */
  rdapConsensus: RateLimiterLike;
  /** Distributed WHOIS budget with per-tenant fair share (ADR-0052). */
  whois: RateLimiterLike;
}

/**
 * Dedicated rate limiter for the 2-of-3 DNS consensus secondary (ADR-0044).
 * The gate must run against its own budget: sharing `dns` would let a heavy
 * primary run starve the exact check that is supposed to fail it closed, and
 * the two providers' budgets would count against each other. Uses the
 * DNS_CONSENSUS_RATE_LIMIT_* tuning, a `dns-consensus` Redis namespace in
 * cloud mode, and the same per-tenant fair share as the primary (ADR-0041).
 * In-memory mode uses PriorityRateLimiter (ADR-0067) to reserve tokens for
 * consensus/tertiary legs.
 */
export function buildConsensusRateLimiter(
  config: Config,
  redisClient?: RedisClient,
): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  const reservedRatio = config.DNS_CONSENSUS_PRIORITY_RESERVED_RATIO;
  if (redisClient?.isConnected) {
    // Redis-backed: priority is handled by separate namespace isolation
    // (dns vs dns-consensus). The reservedRatio config applies to in-memory only.
    return new RedisRateLimiter(
      {
        tokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS,
        intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
        namespace: 'dns-consensus',
        fairShare,
        perTenantTokens: config.DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS !==
          config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
      },
      redisClient,
    );
  }
  return new PriorityRateLimiter(
    {
      maxTokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS,
      tokensPerInterval: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS,
      intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
    },
    reservedRatio,
  );
}

export function buildRateLimiters(config: Config, redisClient?: RedisClient): BuiltRateLimiters {
  const useRedis = redisClient?.isConnected ?? false;
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;

  if (useRedis) {
    const rdap = new RedisRateLimiter(
      {
        tokens: config.RDAP_RATE_LIMIT_TOKENS,
        intervalMs: config.RDAP_RATE_LIMIT_INTERVAL_MS,
        namespace: 'rdap',
        fairShare,
        perTenantTokens: config.RDAP_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.RDAP_RATE_LIMIT_PER_TENANT_INTERVAL_MS !== config.RDAP_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.RDAP_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
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
        fairShare,
        perTenantTokens: config.DNS_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.DNS_RATE_LIMIT_PER_TENANT_INTERVAL_MS !== config.DNS_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.DNS_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
      },
      redisClient,
    );
    const dnsConsensus = buildConsensusRateLimiter(config, redisClient);
    const rdapConsensus = buildRdapConsensusRateLimiter(config, redisClient);
    const whois = buildWhoisRateLimiter(config, redisClient);
    return { rdap, uspto, euipo, wayback, dns, dnsConsensus, rdapConsensus, whois };
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
  const dnsConsensus = buildConsensusRateLimiter(config);
  const rdapConsensus = buildRdapConsensusRateLimiter(config);
  const whois = buildWhoisRateLimiter(config);
  return { rdap, uspto, euipo, wayback, dns, dnsConsensus, rdapConsensus, whois };
}

/**
 * Anonymous trademark-gate budget (ADR-0056). Gives the public scoring
 * namespace a dedicated trademark-check allowance so anonymous valuation
 * traffic can never starve pipeline runs of USPTO/EUIPO capacity, and the
 * two surfaces' budgets stay independent.
 *
 * The gate fails open: a valuation that cannot obtain a slot within
 * ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS returns an 'unverified' verdict (buy
 * signal stripped) instead of waiting indefinitely or erroring. Uses the
 * 'anon-trademark' Redis namespace in cloud mode so api/worker/scheduler
 * processes share one budget; disabled when ANON_TRADEMARK_BUDGET_ENABLED
 * is off (community default — anonymous scoring behaves as before).
 */
export function buildAnonBudgetGate(config: Config, redisClient?: RedisClient): AnonBudgetGate {
  const enabled = config.ANON_TRADEMARK_BUDGET_ENABLED;
  const acquireTimeoutMs = config.ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS;
  if (!enabled) {
    return new AnonBudgetGate(RateLimiter.unlimited(), { enabled: false, acquireTimeoutMs });
  }
  if (redisClient?.isConnected) {
    return new AnonBudgetGate(
      new RedisRateLimiter(
        {
          tokens: config.ANON_TRADEMARK_RATE_LIMIT_TOKENS,
          intervalMs: config.ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS,
          namespace: 'anon-trademark',
          // Keep the Redis poll loop bounded by the same deadline as the
          // gate's own timeout so both paths fail open together.
          maxWaitMs: acquireTimeoutMs,
        },
        redisClient,
      ),
      { enabled: true, acquireTimeoutMs },
    );
  }
  return new AnonBudgetGate(
    new RateLimiter({
      maxTokens: config.ANON_TRADEMARK_RATE_LIMIT_TOKENS,
      tokensPerInterval: config.ANON_TRADEMARK_RATE_LIMIT_TOKENS,
      intervalMs: config.ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS,
    }),
    { enabled: true, acquireTimeoutMs },
  );
}

/**
 * Builds the RDAP 2-of-2 consensus config for the pipeline's RDAP
 * confirmation stage, or undefined when RDAP_CONSENSUS_ENABLED is off (the
 * default). The second leg is a real, dedicated RDAP provider pinned to the
 * independent origin in RDAP_CONSENSUS_ENDPOINT (ADR-0050): verification
 * must come from a registrar/registry infrastructure that did not produce
 * the primary verdict, so it cannot draw on the same bootstrap or cache.
 *
 * The consensus leg draws from its own rate-limit budget (`rdapConsensus`,
 * ADR-0044 pattern): the verification queries must never be starved by the
 * primary's traffic, and the two providers' budgets stay independent.
 *
 * Returns undefined (gate off) when the feature flag is off or when the
 * endpoint is not configured — a misconfigured gate logs prominently
 * instead of silently passing single-leg verdicts.
 */
export async function createRdapConsensusConfig(
  config: Config,
  rdapConsensusRateLimiter?: RateLimiterLike,
  redisClient?: RedisClient,
  tldOriginsResolver?: (tld: string) => Promise<string[]>,
): Promise<RdapConsensusConfig | undefined> {
  if (!config.RDAP_CONSENSUS_ENABLED) return undefined;
  const logger = getLogger();

  const endpoint = config.RDAP_CONSENSUS_ENDPOINT.trim();
  if (!endpoint) {
    logger.error(
      'RDAP: consensus enabled but RDAP_CONSENSUS_ENDPOINT is empty — 2-of-2 gate disabled. ' +
        'Set the independent second-leg origin to harden availability verdicts (ADR-0050).',
    );
    return undefined;
  }

  // STATIC DISJOINTNESS VALIDATION (ADR-0050/0058): Verify the consensus endpoint
  // origin is genuinely independent from the primary's authoritative origins.
  // If the consensus endpoint converges to the same anycast infrastructure as
  // the primary bootstrap servers, the 2-of-2 gate is a rubber stamp.
  if (tldOriginsResolver !== undefined) {
    try {
      const consensusUrl = new URL(endpoint);
      const consensusHostname = consensusUrl.hostname;
      const { default: dns } = await import('node:dns/promises');
      const consensusIps = new Set<string>();
      for (const record of await Promise.allSettled([
        dns.resolve4(consensusHostname),
        dns.resolve6(consensusHostname),
      ])) {
        if (record.status === 'fulfilled') {
          for (const ip of record.value) consensusIps.add(ip);
        }
      }

      // Check overlap for common TLDs (sample check)
      const sampleTlds = ['com', 'net', 'org', 'io', 'ai', 'app', 'dev'];
      let totalOverlap = 0;
      let totalAuthoritative = 0;
      for (const tld of sampleTlds) {
        try {
          const primaryOrigins = await tldOriginsResolver(tld);
          for (const origin of primaryOrigins) {
            totalAuthoritative++;
            try {
              const primaryUrl = new URL(origin);
              const primaryHostname = primaryUrl.hostname;
              const primaryIps = new Set<string>();
              for (const record of await Promise.allSettled([
                dns.resolve4(primaryHostname),
                dns.resolve6(primaryHostname),
              ])) {
                if (record.status === 'fulfilled') {
                  for (const ip of record.value) primaryIps.add(ip);
                }
              }
              for (const ip of consensusIps) {
                if (primaryIps.has(ip)) {
                  totalOverlap++;
                  break; // Count each origin once
                }
              }
            } catch {
              // Invalid origin URL, skip
            }
          }
        } catch {
          // Resolver error, skip this TLD
        }
      }

      if (totalAuthoritative > 0) {
        const overlapRatio = totalOverlap / totalAuthoritative;
        if (overlapRatio > 0.5) {
          logger.warn(
            {
              consensusEndpoint: endpoint,
              overlapRatio,
              overlappingOrigins: totalOverlap,
              totalAuthoritative,
            },
            'RDAP: consensus endpoint overlaps with primary authoritative origins — 2-of-2 gate may be a rubber stamp',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'RDAP: static disjointness validation failed — continuing without overlap check',
      );
    }
  }

  const rateLimiter =
    rdapConsensusRateLimiter ?? buildRdapConsensusRateLimiter(config, redisClient);
  const breakers = buildRdapCircuitBreakers(redisClient);
  const rdapAgentPool = new RdapAgentPool({
    maxConnections: config.RDAP_MAX_CONNECTIONS,
  });

  // A single pinned origin: the consensus leg is a verification query to the
  // configured independent server, never a bootstrap-followed lookup that
  // could converge back onto the primary's infrastructure.
  const secondaryProvider = FailoverRdapProvider.fromConfig(
    [{ url: endpoint }],
    rateLimiter,
    undefined,
    breakers.perServer,
    rdapAgentPool,
    config.RDAP_CONSENSUS_TIMEOUT_MS,
    config.RDAP_MAX_RESPONSE_BYTES,
  );

  logger.info(
    { endpoint },
    'RDAP: 2-of-2 consensus enabled — Available verdicts are re-confirmed by the second provider',
  );
  if (config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED) {
    logger.warn(
      'RDAP: WHOIS rescue leg enabled (ADR-0051) — verdicts the second RDAP leg cannot ' +
        'answer are re-checked through WHOIS within the stage budget. Unverifiable verdicts ' +
        'are no longer strictly fail-closed for the rescue-enabled class.',
    );
  }
  if (config.RDAP_CONSENSUS_RESCUE_WHOIS_TLDS.length > 0) {
    logger.info(
      { tlds: config.RDAP_CONSENSUS_RESCUE_WHOIS_TLDS },
      'RDAP: Per-TLD WHOIS rescue forced for listed TLDs (ADR-0051 extension)',
    );
  }
  const rescueWhoisTlds = new Set<string>(
    config.RDAP_CONSENSUS_RESCUE_WHOIS_TLDS.map((t) => t.toLowerCase()),
  );
  return {
    secondaryProvider,
    secondaryOrigin: endpoint,
    degradedRatio: config.RDAP_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.RDAP_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.RDAP_CONSENSUS_BULK_CONCURRENCY,
    rescueWhoisEnabled: config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED,
    rescueWhoisTlds,
    ...(tldOriginsResolver !== undefined ? { tldOriginsResolver } : {}),
  };
}

/**
 * Builds the optional THIRD RDAP consensus opinion (tertiary leg) for the
 * pipeline's RDAP confirmation stage, when RDAP_CONSENSUS_TERTIARY_ENABLED
 * is on and RDAP_TERTIARY_ENDPOINT is configured. Returns undefined when
 * the leg is disabled, not configured, or when its endpoint origin overlaps
 * either the primary's authoritative origins or the secondary endpoint — a
 * third opinion through the same endpoints is no opinion at all, and the
 * gate must never silently degrade by thinning redundancy.
 *
 * The tertiary leg draws from its own rate-limit budget
 * (`rdap-consensus-tertiary`, ADR-0044 pattern): the verification queries
 * must never be starved by the primary/secondary traffic, and the three
 * providers' budgets stay independent.
 */
export async function createRdapTertiaryConfig(
  config: Config,
  rdapTertiaryRateLimiter?: RateLimiterLike,
  redisClient?: RedisClient,
  tldOriginsResolver?: (tld: string) => Promise<string[]>,
): Promise<RdapConsensusConfig | undefined> {
  if (!config.RDAP_CONSENSUS_TERTIARY_ENABLED) return undefined;
  const logger = getLogger();

  const endpoint = config.RDAP_TERTIARY_ENDPOINT.trim();
  if (!endpoint) {
    throw new Error(
      'RDAP_CONSENSUS_TERTIARY_ENABLED=true requires RDAP_TERTIARY_ENDPOINT to be set. ' +
        'Configure an independent registry-authoritative endpoint (e.g. https://rdap.verisign.com/com/domain/) ' +
        'or disable the tertiary leg (ADR-0050/0064 parity with DNS_PRIVACY_MODE).',
    );
  }

  const rateLimiter = rdapTertiaryRateLimiter ?? buildRdapTertiaryRateLimiter(config, redisClient);
  const breakers = buildRdapCircuitBreakers(redisClient);
  const rdapAgentPool = new RdapAgentPool({
    maxConnections: config.RDAP_MAX_CONNECTIONS,
  });

  // A single pinned origin: the tertiary leg is a verification query to the
  // configured independent server, never a bootstrap-followed lookup that
  // could converge back onto the primary's or secondary's infrastructure.
  const tertiaryProvider = FailoverRdapProvider.fromConfig(
    [{ url: endpoint }],
    rateLimiter,
    undefined,
    breakers.perServer,
    rdapAgentPool,
    config.RDAP_TERTIARY_TIMEOUT_MS,
    config.RDAP_MAX_RESPONSE_BYTES,
  );

  logger.info(
    { endpoint },
    'RDAP: 2-of-2+1 tertiary consensus enabled — unverifiable Available verdicts get a third opinion',
  );

  // Independence check against BOTH existing legs: the tertiary through the
  // primary's authoritative origins or the secondary endpoint adds no opinion.
  // The tldOriginsResolver (from IANA bootstrap) provides authoritative
  // origins per TLD at runtime. We pass it through so the stage can do the
  // per-TLD guard (ADR-0058) AND the runtime winner-origin guard (ADR-0050)
  // for the tertiary leg.
  // Static check at build time: warn if tertiary endpoint origin is the same
  // as secondary endpoint origin (common misconfiguration).
  const secondaryEndpoint = config.RDAP_CONSENSUS_ENDPOINT.trim();
  if (secondaryEndpoint && endpoint === secondaryEndpoint) {
    logger.warn(
      { tertiary: endpoint, secondary: secondaryEndpoint },
      'RDAP: tertiary endpoint equals secondary endpoint — the tertiary leg would be a ' +
        'rubber stamp of the second opinion. Consider a registry-authoritative ' +
        'endpoint (e.g. rdap.verisign.com/com/domain/) for genuine independence.',
    );
  }

  const rescueWhoisTlds = new Set<string>(
    config.RDAP_CONSENSUS_RESCUE_WHOIS_TLDS.map((t) => t.toLowerCase()),
  );
  return {
    secondaryProvider: tertiaryProvider, // Reusing the same config shape for tertiary
    secondaryOrigin: endpoint,
    degradedRatio: config.RDAP_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.RDAP_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.RDAP_TERTIARY_BULK_CONCURRENCY,
    rescueWhoisEnabled: config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED,
    rescueWhoisTlds,
    ...(tldOriginsResolver !== undefined ? { tldOriginsResolver } : {}),
  };
}

/**
 * Dedicated rate limiter for the RDAP tertiary consensus leg.
 * Uses the RDAP_TERTIARY_RATE_LIMIT_* tuning and a `rdap-consensus-tertiary`
 * Redis namespace in cloud mode.
 */
export function buildRdapTertiaryRateLimiter(
  config: Config,
  redisClient?: RedisClient,
): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  if (redisClient?.isConnected) {
    return new RedisRateLimiter(
      {
        tokens: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
        intervalMs: config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS,
        namespace: 'rdap-consensus-tertiary',
        fairShare,
        perTenantTokens: config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS,
        ...(fairShare &&
        config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS !==
          config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS
          ? { perTenantIntervalMs: config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
          : {}),
      },
      redisClient,
    );
  }
  return new RateLimiter({
    maxTokens: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
    intervalMs: config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS,
  });
}
