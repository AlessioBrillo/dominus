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
  UnboundResolver,
  ParkingIpRegistry,
  DnsBreakerRegistry,
  type DnsBreakerRegistryLike,
  type DnsProvider,
} from '../providers/dns/index.js';
import { PriorityRateLimiter, type RateLimiterLike } from '../providers/rate-limiter.js';
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
import { rdapUrlOrigin } from '../providers/rdap/rdap-consensus-validator.js';
import { type RdapProvider } from '../providers/rdap/rdap-provider.js';
import { DomainStatus, type RdapResult } from '../types/domain-status.js';
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
import type { WaybackProvider } from '../providers/wayback/wayback-provider.js';
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
  fresh: RdapProvider;
  ianaBootstrap: IanaRdapBootstrap;
}

export function isRdapResultCacheable(result: RdapResult): boolean {
  return result.status !== 'unknown' && result.status !== 'error';
}

export function isRdapResultStale(result: RdapResult, staleHours: number): boolean {
  if (result.status !== DomainStatus.Available) return false;
  const checkedAtMs = Date.parse(result.checkedAt);
  if (Number.isNaN(checkedAtMs)) return false;
  return Date.now() - checkedAtMs > staleHours * 3_600_000;
}

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

export async function buildDnsProvider(
  config: Config,
  providerCacheRepo?: ProviderCacheRepository,
  rateLimiter?: RateLimiterLike,
  breakers?: DnsBreakerRegistryLike,
  metrics?: {
    recordUnboundResolution: (stats: {
      durationMs: number;
      status: 'registered' | 'available' | 'unknown';
      dnssec: 'valid' | 'unchecked' | 'bogus';
      fromCache: boolean;
      host?: string;
    }) => void;
    recordUnboundHostDnssecChange?: (host: string, validating: boolean) => void;
    recordUnboundHealthyHosts?: (count: number) => void;
  },
): Promise<DnsProvider> {
  // ADR-0075: UnboundResolver is the single DNS source of truth.
  // DNS_UNBOUND_ENABLED=false is no longer supported.
  const unboundHosts = config.DNS_UNBOUND_HOSTS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (unboundHosts.length === 0) {
    throw new Error(
      'DNS_UNBOUND_HOSTS must be set (e.g. "127.0.0.1,::1" or "unbound:5300"). ' +
        'Run an Unbound resolver locally (Docker or host) — see deploy/unbound/.',
    );
  }

  const parkingRegistry = ParkingIpRegistry.load(
    config.DNS_PARKING_IPS_PATH,
    fileURLToPath(new URL('../providers/dns/parking-ips.json', import.meta.url)),
  );

  // Parse distributed positive controls for DNSSEC health checks
  const positiveControls = config.DNSSEC_POSITIVE_CONTROLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const resolver = new UnboundResolver({
    unboundHosts,
    lookupTimeoutMs: config.DNS_UNBOUND_TIMEOUT_MS,
    cacheTtlMs: config.DNS_CACHE_TTL_SECONDS * 1000,
    maxSize: config.DNS_CACHE_MAX_SIZE,
    bulkConcurrency: config.DNS_BULK_CONCURRENCY,
    parkingEnabled: config.DNS_PARKING_CHECK_ENABLED,
    parkingRegistry,
    rateLimiter: rateLimiter as RateLimiterLike,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
    persistentCache:
      config.DNS_PERSISTENT_CACHE_ENABLED && providerCacheRepo !== undefined
        ? providerCacheRepo
        : undefined,
    persistentCacheTtlHours: config.DNS_PERSISTENT_CACHE_TTL_HOURS,
    persistentAvailableStaleMs: config.DNS_PERSISTENT_AVAILABLE_STALE_HOURS * 60 * 60_000,
    breakers,
    dnssecValidationEnabled: config.DNS_DNSSEC_VALIDATION_ENABLED,
    dnssecMode: config.DNSSEC_MODE,
    onResolution: metrics?.recordUnboundResolution,
    onHostDnssecValidationChange: metrics?.recordUnboundHostDnssecChange,
    onDnssecValidationChange: (validating: boolean): void => {
      if (metrics?.recordUnboundHealthyHosts) {
        metrics.recordUnboundHealthyHosts(validating ? resolver.getHealthyHostCount() : 0);
      }
    },
    dnssecRevalidationIntervalMs: config.DNS_UNBOUND_REVALIDATION_INTERVAL_MS,
    maxUnhealthyBeforeFallback: config.DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_DEGRADED,
    unhealthyCooldownMs: config.DNS_UNBOUND_UNHEALTHY_COOLDOWN_MS,
    dnsPerQueryDnssec: config.DNS_PER_QUERY_DNSEC,
    dnsPerQueryDnssecTimeoutMs: config.DNS_PER_QUERY_DNSEC_TIMEOUT_MS,
    positiveControls,
  });

  // Health check at startup (unless disabled for testing)
  if (config.DNS_UNBOUND_HEALTH_CHECK_ENABLED) {
    const health = await resolver.healthCheck();
    if (!health.healthy) {
      throw new Error(
        'Unbound resolver health check failed: no healthy Unbound hosts. ' +
          'Check DNS_UNBOUND_HOSTS and ensure Unbound sidecar/container is running and reachable. ' +
          'Set DNS_UNBOUND_HEALTH_CHECK_ENABLED=false to skip (not recommended for production).',
      );
    }
    if (!health.dnssecValid) {
      throw new Error(
        'Unbound resolver reachable but DNSSEC validation is not confirmed active on any host: ' +
          `${health.details}. Verdicts depend on authenticated NXDOMAIN denial-of-existence — ` +
          'without proven validation a misconfigured Unbound (e.g. val-permissive-mode: yes) ' +
          'silently accepts forged answers. Fix the Unbound config (validator module + ' +
          'val-permissive-mode: no), or set DNS_UNBOUND_HEALTH_CHECK_ENABLED=false to bypass ' +
          '(not recommended for production).',
      );
    }
    // Log per-host results for observability
    for (const hostResult of health.hosts) {
      getLogger().info(
        {
          host: hostResult.host,
          healthy: hostResult.healthy,
          dnssecValid: hostResult.dnssecValid,
          consecutiveFailures: hostResult.consecutiveFailures,
        },
        'Unbound host health check result',
      );
    }
    getLogger().info(
      {
        hosts: unboundHosts,
        dnssecValid: health.dnssecValid,
        healthyHosts: health.hosts.filter((h) => h.healthy).length,
        details: health.details,
      },
      'Unbound resolver health check passed',
    );
  }

  // Start periodic revalidation
  resolver.startPeriodicRevalidation();

  return resolver;
}

export function buildWhoisProviders(
  config: Config,
  redisClient?: RedisClient,
): {
  raw: WhoisProviderInterface;
  withRetry: WhoisProviderInterface;
  rescue: WhoisProviderInterface;
} {
  const defaultConfig = {
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  };
  const raw = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    perTldRateLimiters: buildPerTldWhoisRateLimiters(
      config.WHOIS_RATE_LIMIT_OVERRIDES,
      defaultConfig,
    ),
  });

  const breaker = redisClient?.isConnected
    ? new DistributedCircuitBreaker('whois', WHOIS_CIRCUIT_BREAKER, redisClient)
    : new CircuitBreaker(WHOIS_CIRCUIT_BREAKER);

  const withRetry = new RetryingWhoisProvider(raw, {}, breaker);

  // Dedicated WHOIS provider for RDAP consensus rescue (ADR-0051/ADR-0058).
  // Uses a separate rate limiter namespace to avoid head-of-line blocking
  // on slow ccTLD WHOIS servers (.it, .de, .jp, .br) by the main WHOIS traffic.
  const rescueRateLimiter = redisClient?.isConnected
    ? new RedisRateLimiter({
        tokens: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
        intervalMs: config.RDAP_CONSENSUS_WHOIS_RESCUE_INTERVAL_MS,
        namespace: 'dominus:rdap-consensus-whois-rescue:',
      })
    : new PriorityRateLimiter(
        {
          maxTokens: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
          tokensPerInterval: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
          intervalMs: config.RDAP_CONSENSUS_WHOIS_RESCUE_INTERVAL_MS,
        },
        0,
      );

  // Per-TLD rate limiters for rescue: apply WHOIS_RATE_LIMIT_OVERRIDES
  // merged with rescue defaults so ccTLD-specific limits work for rescue too.
  const rescueDefaultConfig = {
    maxTokens: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
    tokensPerInterval: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
    intervalMs: config.RDAP_CONSENSUS_WHOIS_RESCUE_INTERVAL_MS,
  };
  const rescuePerTldLimiters = buildPerTldWhoisRateLimiters(
    config.WHOIS_RATE_LIMIT_OVERRIDES,
    rescueDefaultConfig,
  );

  const rawRescue = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    defaultRateLimiter: rescueRateLimiter,
    perTldRateLimiters: rescuePerTldLimiters,
  });

  const rescueBreaker = redisClient?.isConnected
    ? new DistributedCircuitBreaker(
        'rdap-consensus-whois-rescue',
        WHOIS_CIRCUIT_BREAKER,
        redisClient,
      )
    : new CircuitBreaker(WHOIS_CIRCUIT_BREAKER);

  const rescue = new RetryingWhoisProvider(rawRescue, {}, rescueBreaker);

  return { raw, withRetry, rescue };
}

export function buildWaybackProvider(
  config: Config,
  _providerCacheRepo?: ProviderCacheRepository,
): WaybackProvider | undefined {
  if (!config.WAYBACK_ENABLED) return undefined;
  const rateLimiter = new PriorityRateLimiter(
    {
      maxTokens: config.WAYBACK_RATE_LIMIT_TOKENS,
      tokensPerInterval: config.WAYBACK_RATE_LIMIT_TOKENS,
      intervalMs: config.WAYBACK_RATE_LIMIT_INTERVAL_MS,
    },
    0,
  );
  return new CdxWaybackProvider(undefined, rateLimiter, config.WAYBACK_TIMEOUT_MS);
}

export function buildRateLimiters(
  config: Config,
  redisClient?: RedisClient,
): {
  rdap: RateLimiterLike;
  uspto: RateLimiterLike;
  euipo: RateLimiterLike;
  dns: RateLimiterLike;
  rdapConsensus: RateLimiterLike;
} {
  const build = (tokens: number, intervalMs: number, namespace: string): RateLimiterLike => {
    if (redisClient?.isConnected) {
      return new RedisRateLimiter({
        tokens,
        intervalMs,
        namespace: `dominus:${namespace}:`,
      } as RedisRateLimiterConfig);
    }
    return new PriorityRateLimiter({ maxTokens: tokens, tokensPerInterval: tokens, intervalMs }, 0);
  };

  return {
    rdap: build(config.RDAP_RATE_LIMIT_TOKENS, config.RDAP_RATE_LIMIT_INTERVAL_MS, 'rdap'),
    uspto: build(config.USPTO_RATE_LIMIT_TOKENS, config.USPTO_RATE_LIMIT_INTERVAL_MS, 'uspto'),
    euipo: build(config.EUIPO_RATE_LIMIT_TOKENS, config.EUIPO_RATE_LIMIT_INTERVAL_MS, 'euipo'),
    dns: build(config.DNS_RATE_LIMIT_TOKENS, config.DNS_RATE_LIMIT_INTERVAL_MS, 'dns'),
    rdapConsensus: build(
      config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
      config.RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
      'rdap:consensus',
    ),
  };
}

export function buildAnonBudgetGate(config: Config, redisClient?: RedisClient): AnonBudgetGate {
  const tokens = config.ANON_TRADEMARK_RATE_LIMIT_TOKENS;
  const intervalMs = config.ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS;
  const timeoutMs = config.ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS;

  const limiter = redisClient?.isConnected
    ? new RedisRateLimiter({
        tokens,
        intervalMs,
        namespace: 'dominus:anon-trademark:',
      } as RedisRateLimiterConfig)
    : new PriorityRateLimiter({ maxTokens: tokens, tokensPerInterval: tokens, intervalMs }, 0);

  return new AnonBudgetGate(limiter, {
    enabled: config.ANON_TRADEMARK_BUDGET_ENABLED,
    acquireTimeoutMs: timeoutMs,
  });
}

export interface RdapConsensusConfig {
  secondaryProvider: RdapProvider;
  secondaryOrigin: string;
  degradedRatio?: number;
  degradedMin?: number;
  consensusConcurrency?: number;
  rescueWhoisEnabled?: boolean;
  rescueWhoisTlds?: Set<string>;
  tldOriginsResolver?: (tld: string) => Promise<string[]>;
  /** Optional tertiary RDAP provider for 3-leg consensus (ADR-0050 extension). */
  tertiaryProvider?: RdapProvider;
  tertiaryOrigin?: string;
  /** Dedicated WHOIS rate limiter for consensus rescue (ADR-0051/ADR-0058). */
  whoisRescueRateLimiter?: RateLimiterLike;
}

function buildRdapConsensusRateLimiter(config: Config, redisClient?: RedisClient): RateLimiterLike {
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
  return new PriorityRateLimiter(
    {
      maxTokens: config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
      tokensPerInterval: config.RDAP_CONSENSUS_RATE_LIMIT_TOKENS,
      intervalMs: config.RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS,
    },
    0,
  );
}

function buildRdapConsensusWhoisRescueRateLimiter(
  config: Config,
  redisClient?: RedisClient,
): RateLimiterLike {
  const fairShare = config.PROVIDER_FAIR_SHARE_ENABLED;
  if (redisClient?.isConnected) {
    return new RedisRateLimiter(
      {
        tokens: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
        intervalMs: config.RDAP_CONSENSUS_WHOIS_RESCUE_INTERVAL_MS,
        namespace: 'rdap-consensus-whois-rescue',
        fairShare,
        perTenantTokens: 1, // minimal per-tenant share for rescue
      },
      redisClient,
    );
  }
  return new PriorityRateLimiter(
    {
      maxTokens: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
      tokensPerInterval: config.RDAP_CONSENSUS_WHOIS_RESCUE_TOKENS,
      intervalMs: config.RDAP_CONSENSUS_WHOIS_RESCUE_INTERVAL_MS,
    },
    0,
  );
}

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
                  break;
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

  const secondaryProvider = FailoverRdapProvider.fromConfig(
    [{ url: endpoint }],
    rateLimiter,
    undefined,
    breakers.perServer,
    rdapAgentPool,
    config.RDAP_CONSENSUS_TIMEOUT_MS,
    config.RDAP_MAX_RESPONSE_BYTES,
  );

  // Dedicated WHOIS rescue rate limiter for consensus (independent budget, ADR-0051/ADR-0058)
  const whoisRescueRateLimiter = buildRdapConsensusWhoisRescueRateLimiter(config, redisClient);

  // Optional tertiary leg (ADR-0050 extension): independent third opinion for rescue
  let tertiaryProvider: RdapProvider | undefined;
  let tertiaryOrigin: string | undefined;
  if (config.RDAP_CONSENSUS_TERTIARY_ENABLED && config.RDAP_TERTIARY_ENDPOINT.trim() !== '') {
    const tertiaryEndpoint = config.RDAP_TERTIARY_ENDPOINT.trim();

    // Validate disjointness: tertiary must not overlap primary authoritative origins or secondary
    let tertiaryValid = true;
    if (tldOriginsResolver !== undefined) {
      try {
        const tertiaryUrl = new URL(tertiaryEndpoint);
        const tertiaryHostname = tertiaryUrl.hostname;
        const { default: dns } = await import('node:dns/promises');
        const tertiaryIps = new Set<string>();
        for (const record of await Promise.allSettled([
          dns.resolve4(tertiaryHostname),
          dns.resolve6(tertiaryHostname),
        ])) {
          if (record.status === 'fulfilled') {
            for (const ip of record.value) tertiaryIps.add(ip);
          }
        }

        // Check against primary authoritative origins
        const sampleTlds = ['com', 'net', 'org', 'io', 'ai', 'app', 'dev'];
        let tertiaryOverlapPrimary = 0;
        let tertiaryAuthoritativePrimary = 0;
        for (const tld of sampleTlds) {
          try {
            const primaryOrigins = await tldOriginsResolver(tld);
            for (const origin of primaryOrigins) {
              tertiaryAuthoritativePrimary++;
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
                for (const ip of tertiaryIps) {
                  if (primaryIps.has(ip)) {
                    tertiaryOverlapPrimary++;
                    break;
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

        if (tertiaryAuthoritativePrimary > 0) {
          const overlapRatio = tertiaryOverlapPrimary / tertiaryAuthoritativePrimary;
          if (overlapRatio > 0.5) {
            logger.warn(
              {
                tertiaryEndpoint,
                overlapRatio,
                overlappingOrigins: tertiaryOverlapPrimary,
                totalAuthoritative: tertiaryAuthoritativePrimary,
              },
              'RDAP: tertiary endpoint overlaps with primary authoritative origins — tertiary leg disabled',
            );
            tertiaryValid = false;
          }
        }

        // Check against secondary origin
        if (tertiaryValid) {
          const secondaryOriginUrl = new URL(endpoint).origin;
          if (rdapUrlOrigin(tertiaryEndpoint) === secondaryOriginUrl) {
            logger.warn(
              { tertiaryEndpoint, secondaryEndpoint: endpoint },
              'RDAP: tertiary endpoint overlaps with secondary origin — tertiary leg disabled',
            );
            tertiaryValid = false;
          }
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'RDAP: tertiary disjointness validation failed — continuing without overlap check',
        );
      }
    }

    if (tertiaryValid) {
      const tertiaryRateLimiter = redisClient?.isConnected
        ? new RedisRateLimiter(
            {
              tokens: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
              intervalMs: config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS,
              namespace: 'rdap-consensus-tertiary',
              fairShare: config.PROVIDER_FAIR_SHARE_ENABLED,
              perTenantTokens: config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS,
              ...(config.PROVIDER_FAIR_SHARE_ENABLED &&
              config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS !==
                config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS
                ? { perTenantIntervalMs: config.RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS }
                : {}),
            },
            redisClient,
          )
        : new PriorityRateLimiter(
            {
              maxTokens: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
              tokensPerInterval: config.RDAP_TERTIARY_RATE_LIMIT_TOKENS,
              intervalMs: config.RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS,
            },
            0,
          );

      const tertiaryBreakers = buildRdapCircuitBreakers(redisClient);
      const tertiaryAgentPool = new RdapAgentPool({
        maxConnections: config.RDAP_MAX_CONNECTIONS,
      });

      tertiaryProvider = FailoverRdapProvider.fromConfig(
        [{ url: tertiaryEndpoint }],
        tertiaryRateLimiter,
        undefined,
        tertiaryBreakers.perServer,
        tertiaryAgentPool,
        config.RDAP_TERTIARY_TIMEOUT_MS,
        config.RDAP_MAX_RESPONSE_BYTES,
      );
      tertiaryOrigin = tertiaryEndpoint;

      logger.info(
        { tertiaryEndpoint },
        'RDAP: 3-leg consensus enabled — tertiary leg rescues unverifiable verdicts from secondary',
      );
    } else {
      logger.warn(
        { tertiaryEndpoint: config.RDAP_TERTIARY_ENDPOINT },
        'RDAP: tertiary leg configured but disabled due to overlap or missing endpoint',
      );
    }
  }

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
  const result: RdapConsensusConfig = {
    secondaryProvider,
    secondaryOrigin: endpoint,
    degradedRatio: config.RDAP_CONSENSUS_DEGRADED_RATIO,
    degradedMin: config.RDAP_CONSENSUS_DEGRADED_MIN,
    consensusConcurrency: config.RDAP_CONSENSUS_BULK_CONCURRENCY,
    rescueWhoisEnabled: config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED,
    rescueWhoisTlds,
    whoisRescueRateLimiter,
    ...(tertiaryProvider !== undefined ? { tertiaryProvider } : {}),
    ...(tertiaryOrigin !== undefined ? { tertiaryOrigin } : {}),
    ...(tldOriginsResolver !== undefined ? { tldOriginsResolver } : {}),
  };
  return result;
}

export interface RdapConsensusProbeResult {
  success: boolean;
  wasFailOpen: boolean;
  attempts: number;
}

export async function probeRdapConsensusEndpoint(
  config: Config,
  secondaryProvider: RdapProvider,
): Promise<RdapConsensusProbeResult> {
  if (!config.RDAP_CONSENSUS_ENABLED) return { success: true, wasFailOpen: false, attempts: 0 };
  const logger = getLogger();
  const endpoint = config.RDAP_CONSENSUS_ENDPOINT;
  const timeoutMs = config.RDAP_CONSENSUS_PROBE_TIMEOUT_MS ?? config.RDAP_CONSENSUS_TIMEOUT_MS;
  const maxRetries = config.RDAP_CONSENSUS_PROBE_RETRY ?? 3;
  const backoffMs = config.RDAP_CONSENSUS_PROBE_BACKOFF_MS ?? 5000;
  const failOpen = config.RDAP_CONSENSUS_PROBE_FAIL_OPEN ?? false;

  logger.warn(
    { endpoint, timeoutMs, maxRetries, backoffMs, failOpen },
    'RDAP: probing consensus second provider at startup',
  );

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const probeSignal = AbortSignal.timeout(timeoutMs);
    try {
      await secondaryProvider.confirm('example.com', probeSignal);
      logger.info({ endpoint, attempt }, 'RDAP: consensus second provider probe succeeded');
      return { success: true, wasFailOpen: false, attempts: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = attempt > maxRetries;

      if (isLastAttempt) {
        logger.error(
          { err: message, endpoint, attempts: attempt - 1, maxRetries, failOpen },
          'RDAP: consensus second provider unreachable at startup — the fail-closed 2-of-2 ' +
            'gate will downgrade unconfirmable Available verdicts. Verify egress to the ' +
            'consensus endpoint or disable the gate (RDAP_CONSENSUS_ENABLED=false).',
        );

        if (failOpen) {
          logger.warn(
            { endpoint, attempts: attempt - 1, maxRetries },
            'RDAP: RDAP_CONSENSUS_PROBE_FAIL_OPEN=true — continuing startup with consensus gate DISABLED. ' +
              'The 2-of-2 RDAP consensus will be skipped for this run; Available verdicts will not be independently verified. ' +
              'Set RDAP_CONSENSUS_ENABLED=false to persist this behavior.',
          );
          return { success: true, wasFailOpen: true, attempts: attempt };
        }

        return { success: false, wasFailOpen: false, attempts: attempt };
      }

      // Exponential backoff with jitter
      const delay = backoffMs * Math.pow(2, attempt - 1);
      const jitter = delay * (0.8 + Math.random() * 0.4);

      logger.warn(
        { err: message, endpoint, attempt, nextRetryInMs: Math.round(jitter) },
        `RDAP: consensus probe attempt ${attempt} failed — retrying`,
      );

      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  return { success: false, wasFailOpen: false, attempts: maxRetries + 1 };
}
