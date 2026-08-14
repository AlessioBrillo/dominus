// SPDX-License-Identifier: AGPL-3.0-only
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
  collectResolverEndpoints,
  strategyToResolverGroups,
  type DnsLookupStrategy,
  type DnsProvider,
  type DnsResolverGroup,
} from '../providers/dns/index.js';
import {
  validateConsensusEndpointDisjointness,
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
} from '../providers/dns/resolver-validator.js';
import { RateLimiter, type RateLimiterLike } from '../providers/rate-limiter.js';
import { AnonBudgetGate } from '../providers/anon-budget-gate.js';
import {
  RedisRateLimiter,
  DistributedCircuitBreaker,
  type RedisClient,
} from '../providers/redis/index.js';
import {
  FailoverRdapProvider,
  RdapAgentPool,
  type RdapBootstrapUrlEntry,
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

export function buildRdapProviders(
  config: Config,
  rdapRateLimiter: RateLimiterLike,
  providerCacheRepo: ProviderCacheRepository,
  redisClient?: RedisClient,
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
        )
      : FailoverRdapProvider.withDefaults(
          rdapRateLimiter,
          undefined,
          ianaBootstrap,
          breakers.perServer,
          rdapAgentPool,
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
  const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
  return new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    // When a private recursor is pinned (C3, e.g. Unbound on 127.0.0.1:5300)
    // the secondary queries it with plain native DNS — no dependency on
    // egress TCP/853 that the default 'dot-only' strategy requires. Without
    // the pin the configured DNS_CONSENSUS_STRATEGY is used verbatim.
    lookupStrategy: consensusNameservers ? 'native' : config.DNS_CONSENSUS_STRATEGY,
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    ...(consensusNameservers !== undefined ? { nameservers: consensusNameservers } : {}),
    rateLimiter,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
  });
}

/**
 * Builds the DNS 2-of-3 consensus config for the pipeline's DNS prefilter
 * stage, or undefined when DNS_CONSENSUS_ENABLED is off (the default).
 *
 * `consensusRateLimiter` is the dedicated consensus budget (ADR-0044): the
 * secondary provider must NOT draw from the primary DNS bucket, else a heavy
 * run would starve the very gate that is supposed to fail it closed. When
 * omitted, a dedicated in-memory limiter is built from the
 * DNS_CONSENSUS_RATE_LIMIT_* config so the isolation holds even for callers
 * that never build the shared budget.
 */
export function buildDnsConsensusConfig(
  config: Config,
  consensusRateLimiter?: RateLimiterLike,
): ConsensusDnsConfig | undefined {
  if (!config.DNS_CONSENSUS_ENABLED) return undefined;

  // A pinned private recursor (C3) replaces the consensus strategy's resolver
  // set with a native query to the local Unbound — the effective secondary
  // lookup mode is 'native' regardless of DNS_CONSENSUS_STRATEGY.
  const consensusNameservers = resolveNameservers(config.DNS_CONSENSUS_NAMESERVERS);
  const effectiveConsensusStrategy: string = consensusNameservers
    ? 'native'
    : config.DNS_CONSENSUS_STRATEGY;

  if (
    !validateConsensusStrategyDisjointness(
      config.DNS_CONSENSUS_ENABLED,
      config.DNS_LOOKUP_STRATEGY,
      effectiveConsensusStrategy,
    )
  ) {
    return undefined;
  }

  // Endpoint-level check: two strategies can pass the name check yet still
  // resolve through the same servers (e.g. 'doh-only' vs 'doh-primary' both
  // race the same default DoH endpoints, or a pinned 'native' reusing the
  // DoT IPs). Overlap means the secondary adds no independent opinion, so
  // consensus is disabled at startup with an explanatory log (ADR-0002).
  const nameservers = resolveNameservers(config.DNS_NAMESERVERS);
  const primaryGroups =
    (config.DNS_RESOLVER_GROUPS as DnsResolverGroup[] | undefined) ??
    strategyToResolverGroups(config.DNS_LOOKUP_STRATEGY, config.DNS_DOH_ENDPOINT);
  const consensusGroups = strategyToResolverGroups(
    effectiveConsensusStrategy,
    config.DNS_DOH_ENDPOINT,
  );
  // The consensus resolver set: a pinned private recursor overrides; otherwise
  // the shared DNS_NAMESERVERS apply (a native consensus reuses them).
  const effectiveConsensusNameservers = consensusNameservers ?? nameservers;
  if (
    !validateConsensusEndpointDisjointness(
      collectResolverEndpoints(primaryGroups, nameservers),
      collectResolverEndpoints(consensusGroups, effectiveConsensusNameservers),
    )
  ) {
    return undefined;
  }
  const secondaryRateLimiter = consensusRateLimiter ?? buildConsensusRateLimiter(config, undefined);
  const tertiaryProvider = buildTertiaryConsensusProvider(
    config,
    secondaryRateLimiter,
    primaryGroups,
    nameservers,
    consensusGroups,
    effectiveConsensusNameservers,
  );
  return {
    secondaryProvider: buildSecondaryDnsProvider(config, secondaryRateLimiter),
    degradedRatio: config.DNS_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.DNS_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.DNS_CONSENSUS_BULK_CONCURRENCY,
    ...(tertiaryProvider !== undefined ? { tertiaryProvider } : {}),
    requiredAvailable: config.DNS_CONSENSUS_REQUIRED_AVAILABLE,
  };
}

/**
 * Builds the optional THIRD DNS consensus opinion (ADR-0045), when
 * DNS_TERTIARY_ENABLED is on. Returns undefined when the leg is disabled or
 * when its resolver set overlaps either the primary or the secondary —
 * a third opinion through the same endpoints is no opinion at all, and the
 * gate must never silently degrade by thinning redundancy. Shares the
 * dedicated consensus rate-limit budget (ADR-0044): the whole verification
 * gate counts against its own bucket, never against the primary's.
 */
function buildTertiaryConsensusProvider(
  config: Config,
  rateLimiter: RateLimiterLike,
  primaryGroups: DnsResolverGroup[],
  primaryNameservers: string[] | undefined,
  consensusGroups: DnsResolverGroup[],
  consensusNameservers: string[] | undefined,
): DnsProvider | undefined {
  if (!config.DNS_TERTIARY_ENABLED) return undefined;

  const logger = getLogger();
  // A pinned private recursor replaces the strategy's resolver set with a
  // native query to the local recursor — mirroring the secondary's C3 rule.
  const tertiaryNameservers = resolveNameservers(config.DNS_TERTIARY_NAMESERVERS);
  const effectiveTertiaryStrategy: DnsLookupStrategy = tertiaryNameservers
    ? 'native'
    : config.DNS_TERTIARY_STRATEGY;
  const tertiaryGroups = strategyToResolverGroups(
    effectiveTertiaryStrategy,
    config.DNS_DOH_ENDPOINT,
  );
  const effectiveTertiaryNameservers = tertiaryNameservers ?? primaryNameservers;

  // Endpoint-level disjointness against BOTH existing legs: the tertiary
  // through the primary's or the secondary's own servers adds no opinion.
  const tertiaryEndpoints = collectResolverEndpoints(tertiaryGroups, effectiveTertiaryNameservers);
  const primaryEndpoints = collectResolverEndpoints(primaryGroups, primaryNameservers);
  const consensusEndpoints = collectResolverEndpoints(consensusGroups, consensusNameservers);
  if (
    !validateConsensusEndpointDisjointness(primaryEndpoints, tertiaryEndpoints) ||
    !validateConsensusEndpointDisjointness(consensusEndpoints, tertiaryEndpoints)
  ) {
    logger.warn(
      {
        strategy: effectiveTertiaryStrategy,
        nameservers: effectiveTertiaryNameservers,
      },
      'DNS: tertiary consensus leg disabled — its resolver set overlaps the primary ' +
        'or the secondary. A third opinion through the same servers adds no information ' +
        '(ADR-0045). Pin DNS_TERTIARY_NAMESERVERS to an independent recursor.',
    );
    return undefined;
  }

  return new NodeDnsProvider({
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    lookupTimeoutMs: config.DNS_LOOKUP_TIMEOUT_MS,
    lookupStrategy: effectiveTertiaryStrategy,
    dohEndpoint: config.DNS_DOH_ENDPOINT,
    dohMaxConnections: config.DNS_DOH_MAX_CONNECTIONS,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    ...(effectiveTertiaryNameservers !== undefined
      ? { nameservers: effectiveTertiaryNameservers }
      : {}),
    rateLimiter,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
  });
}

/**
 * Startup probe for the DNS consensus secondary provider. With strict
 * 2-of-3 consensus semantics (ADR-0002) any failure of the secondary
 * downgrades every Available to Unknown, so a dead secondary (e.g. egress
 * port 853 filtered, blocking the default 'dot-only' strategy) is a silent
 * outage worth surfacing at boot. Non-fatal: consensus stays enabled, but
 * the operator is told clearly what is happening.
 */
export function probeConsensusProvider(config: Config, secondaryProvider: DnsProvider): void {
  if (!config.DNS_CONSENSUS_ENABLED) return;
  const logger = getLogger();
  logger.warn(
    { strategy: config.DNS_CONSENSUS_STRATEGY },
    'DNS: probing consensus secondary provider at startup',
  );
  validateResolverGroups(secondaryProvider).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: message, strategy: config.DNS_CONSENSUS_STRATEGY },
      'DNS: consensus secondary provider unreachable at startup — strict consensus ' +
        'will downgrade every Available verdict to Unknown. Verify DNS_CONSENSUS_STRATEGY ' +
        'egress (dot-only uses TCP/853) or consider DNS_CONSENSUS_ENABLED=false.',
    );
  });
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

export function buildWhoisProviders(config: Config, redisClient?: RedisClient): BuiltWhoisProvider {
  const whoisDefaultLimiter = buildWhoisRateLimiter(config, redisClient);

  const whoisPerTldLimiters = buildWhoisPerTldRateLimiters(config, redisClient);

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
 */
export function buildConsensusRateLimiter(
  config: Config,
  redisClient?: RedisClient,
): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  if (redisClient?.isConnected) {
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
  return new RateLimiter({
    maxTokens: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.DNS_CONSENSUS_RATE_LIMIT_TOKENS,
    intervalMs: config.DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
  });
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
export function createRdapConsensusConfig(
  config: Config,
  rdapConsensusRateLimiter?: RateLimiterLike,
  redisClient?: RedisClient,
  tldOriginsResolver?: (tld: string) => Promise<string[]>,
): RdapConsensusConfig | undefined {
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
  return {
    secondaryProvider,
    secondaryOrigin: endpoint,
    degradedRatio: config.RDAP_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.RDAP_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.RDAP_CONSENSUS_BULK_CONCURRENCY,
    rescueWhoisEnabled: config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED,
    ...(tldOriginsResolver !== undefined ? { tldOriginsResolver } : {}),
  };
}
