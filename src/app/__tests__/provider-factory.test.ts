// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAnonBudgetGate,
  buildConsensusRateLimiter,
  buildDnsConsensusConfig,
  buildRateLimiters,
  buildRdapCircuitBreakers,
  buildWhoisPerTldRateLimiters,
  buildWhoisRateLimiter,
  createRdapConsensusConfig,
  isRdapResultCacheable,
  isRdapResultStale,
  parseRdapBootstrapUrls,
  probeRdapConsensusEndpoint,
} from '../provider-factory.js';
import { validateConsensusStrategyDisjointness } from '../../providers/dns/resolver-validator.js';
import type { Config } from '../../config.js';
import { CircuitBreaker } from '../../providers/circuit-breaker.js';
import { RateLimiter } from '../../providers/rate-limiter.js';
import {
  DistributedCircuitBreaker,
  RedisRateLimiter,
  type RedisClient,
} from '../../providers/redis/index.js';
import { DomainStatus } from '../../types/domain-status.js';
import { FailoverRdapProvider } from '../../providers/rdap/failover-rdap-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import { getLogger, resetLogger } from '../../logger.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    DATABASE_BUSY_TIMEOUT: 30000,
    PORT: 3000,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_HOLDING_YEARS: 3,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    KEYWORD_DATA_PATH: './examples/keywords-sample.json',
    KEYWORD_PROVIDER: 'manual',
    COMPS_DATA_PATH: './examples/comps-sample.csv',
    COMPS_PROVIDER: 'manual',
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_CLIENT_ID: undefined,
    EUIPO_CLIENT_SECRET: undefined,
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://euipo.europa.eu/api',
    TM_CACHE_TTL_DAYS: 7,
    SCORING_WEIGHTS_OVERRIDE: undefined,
    DNS_BULK_CONCURRENCY: 10,
    DNS_LOOKUP_TIMEOUT_MS: 3000,
    DNS_LOOKUP_STRATEGY: 'native',
    DNS_DOH_ENDPOINT: 'https://cloudflare-dns.com/dns-query',
    DNS_CACHE_TTL_SECONDS: 300,
    DNS_CACHE_MAX_SIZE: 10000,
    DNS_RATE_LIMIT_TOKENS: 20,
    DNS_RATE_LIMIT_INTERVAL_MS: 1000,
    WHOIS_LOOKUP_TIMEOUT: 10_000,
    RDAP_RATE_LIMIT_TOKENS: 10,
    RDAP_RATE_LIMIT_INTERVAL_MS: 1000,
    RDAP_RATE_LIMIT_PER_TENANT_TOKENS: 3,
    RDAP_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    PROVIDER_FAIR_SHARE_ENABLED: false,
    DNS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
    DNS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    USPTO_TSDR_SEARCH_URL: 'https://tsdr.uspto.gov/tsdr/tmsearch/data',
    USPTO_RATE_LIMIT_TOKENS: 5,
    USPTO_RATE_LIMIT_INTERVAL_MS: 1000,
    EUIPO_RATE_LIMIT_TOKENS: 5,
    EUIPO_RATE_LIMIT_INTERVAL_MS: 1000,
    WHOIS_RATE_LIMIT_TOKENS: 1,
    WHOIS_RATE_LIMIT_INTERVAL_MS: 2000,
    WHOIS_RATE_LIMIT_PER_TENANT_TOKENS: 1,
    WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 2000,
    BUY_MAX_ABSOLUTE_CAP: 500,
    HOST: '127.0.0.1',
    RENEWAL_WARNING_DAYS: 30,
    RENEWAL_CRITICAL_DAYS: 7,
    DEFAULT_RENEWAL_COST_EUR: 10,
    NOTIFIER_DESKTOP_ENABLED: false,
    NOTIFIER_WEBHOOK_URL: undefined,
    NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
    NOTIFIER_TELEGRAM_CHAT_ID: undefined,
    PIPELINE_TIMEOUT_MS: 3_600_000,
    PIPELINE_CHECKPOINTS_ENABLED: true,
    JOB_QUEUE_MAX_DEPTH: 1000,
    SCHEDULER_ENABLED: false,
    SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
    SCHEDULER_RESCORE_CRON: '0 9 * * 1',
    SCHEDULER_PRUNE_CRON: '0 10 1 * *',
    SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
    SCHEDULER_WARMUP_MS: 5000,
    BACKUP_DIR: './data/backup',
    BACKUP_RETENTION_DAYS: 30,
    SCHEDULER_BACKUP_CRON: '0 4 * * *',
    SCHEDULER_PITR_HEALTH_CRON: '*/15 * * * *',
    PITR_WAL_LAG_MAX_BYTES: 64 * 1024 * 1024,
    PITR_BASE_BACKUP_MAX_AGE_HOURS: 26,
    SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: '0 2 * * 0',
    WATCHLIST_POLL_INTERVAL_HOURS: 6,
    WATCHLIST_RDAP_DELAY_MS: 200,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    RATE_LIMIT_MAX: 100,
    PUBLIC_RATE_LIMIT_WINDOW_MS: 60_000,
    PUBLIC_RATE_LIMIT_MAX: 30,
    PER_DOMAIN_RATE_LIMIT_WINDOW_MS: 60_000,
    PER_DOMAIN_RATE_LIMIT_MAX: 5,
    POST_RATE_LIMIT_WINDOW_MS: 60_000,
    POST_RATE_LIMIT_MAX: 10,
    POST_BODY_MAX_BYTES: 1000,
    RDAP_BATCH_CONCURRENCY: 5,
    RDAP_MAX_CONNECTIONS: 32,
    RDAP_CONSENSUS_ENABLED: false,
    RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: false,
    RDAP_CONSENSUS_ENDPOINT: '',
    RDAP_BOOTSTRAP_RETRY_BASE_MS: 300000,
    RDAP_BOOTSTRAP_RETRY_MAX_MS: 86400000,
    RDAP_CONSENSUS_DEGRADED_RATIO: 0.5,
    RDAP_CONSENSUS_DEGRADED_MIN: 10,
    RDAP_CONSENSUS_RATE_LIMIT_TOKENS: 5,
    RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
    RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 2,
    RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    RDAP_CONSENSUS_BULK_CONCURRENCY: 10,
    RDAP_CONSENSUS_TIMEOUT_MS: 10000,

    REGISTRAR_PROVIDER: 'manual',
    PURCHASE_AUTO_APPROVAL: 'never',
    AUTO_TUNE_ENABLED: false,
    AUTO_TUNE_WEIGHTS_PATH: './data/weights-override.json',
    AUTO_TUNE_MIN_SAMPLE: 20,
    AUTO_TUNE_MAX_DELTA: 0.05,
    AUTO_TUNE_MAX_DRIFT: 0.2,
    AUTO_TUNE_DRY_RUN: true,
    AUTO_TUNE_CRON: '0 6 1 * *',
    SCORING_IDEAL_LENGTH: 7,
    SCORING_MAX_LENGTH: 20,
    SCORING_MAX_VOLUME: 1_000_000,
    SCORING_MAX_CPC: 50,
    SCORING_FLOOR_VALUE: 500,
    SCORING_HIGH_VALUE: 10_000,
    SCORING_MAX_AGE_YEARS: 20,
    SCORING_MAX_BACKLINKS: 1000,
    SCORING_MAX_WAYBACK: 500,
    SCORING_BUY_MAX_RATIO: 0.5,
    SCORING_LIST_PRICE_MULTIPLIER: 2.5,
    SCORING_BASE_MARKET_VALUE: 500,
    SCORING_CONFIDENCE_BASE: 0.2,
    SCORING_CONFIDENCE_CAP: 0.8,
    TLD_BONUSES_PATH: undefined,
    DEFAULT_KEYWORD_TLD: '.com',
    TRADEMARK_MIN_TOKEN_LENGTH_FUZZY: 4,
    TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING: 3,
    TRADEMARK_MAX_LEVENSHTEIN: 1,
    TRADEMARK_PROVIDER_TIMEOUT_MS: 15000,
    PROVIDER_CACHE_TTL_DAYS: 7,
    PROVIDER_MEMORY_CACHE_SIZE: 1000,
    PROVIDER_MEMORY_CACHE_TTL_SECONDS: 300,
    TRADEMARK_BATCH_CONCURRENCY: 3,
    WHOIS_BATCH_CONCURRENCY: 3,
    WHOIS_PER_QUERY_TIMEOUT_MS: 10000,
    RESCORE_BATCH_CONCURRENCY: 5,
    REQUEST_TIMEOUT_MS: 30000,
    FRONTEND_DIST_PATH: './frontend/dist',
    FRONTEND_BASE_PATH: '',
    PUBLIC_CACHE_TTL_MS: 300000,
    ANON_TRADEMARK_BUDGET_ENABLED: false,
    ANON_TRADEMARK_RATE_LIMIT_TOKENS: 2,
    ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS: 1000,
    ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS: 1000,
    NAMEBIO_API_KEY: undefined,
    SCORING_INTRINSIC_QUALITY_INFLUENCE: 0.12,
    DROP_METHOD: 'threshold',
    DROP_NPV_DISCOUNT_RATE: 0.05,
    DROP_NPV_HORIZON_YEARS: 5,
    FILE_REGISTRAR_CONFIG: undefined,
    WORKER_ENABLED: false,
    USAGE_ENFORCEMENT_ENABLED: false,
    AUTO_PROVISION_TENANTS: false,
    WORKER_CONCURRENCY: 2,
    JOB_QUEUE_POLL_INTERVAL_MS: 1000,
    JOB_MAX_RUNNING_AGE_MS: 300000,
    JOB_HEARTBEAT_INTERVAL_MS: 15000,
    LISTING_PROVIDER: 'manual' as const,
    LISTING_DEFAULT_MARKETPLACE: 'manual' as const,
    LISTING_DEFAULT_PRICE_MULTIPLIER: 1.0,
    WAYBACK_ENABLED: true,
    WAYBACK_RATE_LIMIT_TOKENS: 5,
    WAYBACK_RATE_LIMIT_INTERVAL_MS: 12000,
    WAYBACK_TIMEOUT_MS: 10000,
    WAYBACK_BATCH_CONCURRENCY: 3,
    SCORING_BATCH_CONCURRENCY: 5,
    WAYBACK_CDX_PAGE_SIZE: 5000,
    DNS_PARKING_CHECK_ENABLED: false,
    DNS_CIRCUIT_BREAKER_ENABLED: true,
    DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
    DNS_CIRCUIT_BREAKER_WINDOW_MS: 60_000,
    DNS_CIRCUIT_BREAKER_COOLDOWN_MS: 120_000,
    TRUST_PROXY_DEPTH: 1,
    AUTH_PROVIDER: 'env',
    DNS_PARKING_IPS_PATH: undefined,
    PUBLIC_SCORES_RETENTION_DAYS: 90,
    EVENTS_RETENTION_DAYS: 180,
    REDIS_TLS_ENABLED: false,
    REDIS_KEY_PREFIX: 'dominus:',
    REDIS_MAX_RETRIES: 10,
    REDIS_RETRY_BASE_MS: 200,
    ACQUISITION_BUDGET_EUR: 500,
    ACQUISITION_MIN_CONFIDENCE: 0.3,
    ACQUISITION_MIN_BUY_MAX: 20,
    ACQUISITION_FUNNEL_MAX_ENTRIES: 0,
    DNS_PERSISTENT_CACHE_ENABLED: true,
    DNS_PERSISTENT_CACHE_TTL_HOURS: 24,
    DNS_PERSISTENT_AVAILABLE_STALE_HOURS: 24,
    RDAP_PERSISTENT_AVAILABLE_STALE_HOURS: 24,
    DNS_CONSENSUS_ENABLED: false,
    DNS_CONSENSUS_STRATEGY: 'dot-only',
    DNS_CONSENSUS_DEGRADED_RATIO: 0.5,
    DNS_CONSENSUS_DEGRADED_MIN: 10,
    DNS_CONSENSUS_RATE_LIMIT_TOKENS: 20,
    DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_BULK_CONCURRENCY: 20,
    DNS_TERTIARY_ENABLED: false,
    DNS_TERTIARY_STRATEGY: 'native',
    DNS_TERTIARY_NAMESERVERS: undefined,
    DNS_CONSENSUS_REQUIRED_AVAILABLE: 1,
    DNS_DOH_MAX_CONNECTIONS: 64,
    DNS_USE_DEDICATED_RESOLVER: true,
    DNS_DOT_POOL_MAX_QUEUED: 4096,
    RDAP_WHOIS_BUDGET_MS: 1000,
    STAGE_TIMEOUT_BASE_MS: 30_000,
    STAGE_TIMEOUT_PER_CANDIDATE_MS: 200,
    STAGE_TIMEOUT_CAP_MS: 3_600_000,
    STAGE_TIMEOUT_GRACE_MS: 5_000,
    ...overrides,
  };
}

// Regression: the 2-of-3 consensus feature (dns-prefilter-stage.ts) was fully
// implemented and unit-tested but composition-root never passed a
// consensusConfig, so it never ran in production. This locks in the
// wiring decision at the factory boundary.
describe('buildDnsConsensusConfig', () => {
  it('returns undefined when DNS_CONSENSUS_ENABLED is false (default)', () => {
    const config = makeConfig({ DNS_CONSENSUS_ENABLED: false });
    expect(buildDnsConsensusConfig(config)).toBeUndefined();
  });

  it('returns a secondaryProvider when DNS_CONSENSUS_ENABLED is true', () => {
    const config = makeConfig({ DNS_CONSENSUS_ENABLED: true, DNS_CONSENSUS_STRATEGY: 'dot-only' });
    const result = buildDnsConsensusConfig(config);
    expect(result).toBeDefined();
    expect(result?.secondaryProvider).toBeDefined();
    expect(typeof result?.secondaryProvider.checkAvailability).toBe('function');
  });

  it('returns undefined when the secondary reuses the primary DoH endpoints', () => {
    // 'doh-only' and 'doh-primary' pass the strategy-name check but both race
    // the same Cloudflare/Google/Quad9 DoH resolvers — no independent opinion.
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'doh-only',
      DNS_CONSENSUS_STRATEGY: 'doh-primary',
    });
    expect(buildDnsConsensusConfig(config)).toBeUndefined();
  });

  it('returns undefined when a pinned native secondary reuses the DoT IPs', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'native',
      DNS_NAMESERVERS: '1.1.1.1',
    });
    expect(buildDnsConsensusConfig(config)).toBeUndefined();
  });

  it('threads the degraded ratio/min tuning knobs into the consensus config', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_CONSENSUS_STRATEGY: 'dot-only',
      DNS_CONSENSUS_DEGRADED_RATIO: 0.3,
      DNS_CONSENSUS_DEGRADED_MIN: 25,
    });
    const result = buildDnsConsensusConfig(config);
    expect(result?.degradedRatio).toBe(0.3);
    expect(result?.degradedMin).toBe(25);
  });

  it('returns undefined when DNS_CONSENSUS_NAMESERVERS reuses the primary resolvers', () => {
    // A private-recursor pin (C3) is not an independent opinion when it
    // forwards to the same public resolvers the primary already queries.
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'native',
      DNS_CONSENSUS_NAMESERVERS: '1.1.1.1',
    });
    expect(buildDnsConsensusConfig(config)).toBeUndefined();
  });

  it('uses the private recursor as the secondary when DNS_CONSENSUS_NAMESERVERS is set', () => {
    // C3: 'dot-only' consensus needs egress TCP/853, which is not guaranteed
    // on a single-VM deployment. When the operator pins a private recursor
    // (e.g. Unbound on 127.0.0.1:5300), the secondary must query it via
    // plain native DNS instead of the public DoT strategy.
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'doh-primary',
      DNS_CONSENSUS_STRATEGY: 'dot-only',
      DNS_CONSENSUS_NAMESERVERS: '127.0.0.1:5300',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result).toBeDefined();
    expect(typeof result?.secondaryProvider.checkAvailability).toBe('function');
  });

  it('keeps the consensus strategy when no private recursor is pinned', () => {
    // Backward compatible: without DNS_CONSENSUS_NAMESERVERS the secondary
    // is built exactly as before (dot-only default).
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'doh-primary',
      DNS_CONSENSUS_STRATEGY: 'dot-only',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result).toBeDefined();
  });
});

describe('buildDnsConsensusConfig tertiary leg (ADR-0045)', () => {
  it('builds a tertiary provider from a pinned independent recursor', () => {
    // A pinned third recursor (e.g. a second Unbound instance) is the
    // standard way to add a genuinely independent opinion: native DNS to
    // 192.0.2.1:53 shares no endpoint with the DoH primary or the DoT
    // secondary, so the disjointness gate lets it through.
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
      DNS_TERTIARY_ENABLED: true,
      DNS_TERTIARY_STRATEGY: 'native',
      DNS_TERTIARY_NAMESERVERS: '192.0.2.1:53',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result).toBeDefined();
    expect(typeof result?.tertiaryProvider?.checkAvailability).toBe('function');
  });

  it('uses DNS_TERTIARY_STRATEGY when no tertiary nameservers are pinned', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
      DNS_TERTIARY_ENABLED: true,
      DNS_TERTIARY_STRATEGY: 'native',
    });
    const result = buildDnsConsensusConfig(config);
    expect(typeof result?.tertiaryProvider?.checkAvailability).toBe('function');
  });

  it('does not build a tertiary leg when DNS_TERTIARY_ENABLED is off', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result?.tertiaryProvider).toBeUndefined();
  });

  it('drops the tertiary leg when it overlaps the secondary resolver set', () => {
    // 'doh-only' (secondary) and 'doh-primary' (tertiary) both race the same
    // default DoH endpoints — a third opinion on the same servers adds no
    // information, so the leg is dropped at startup with a warning.
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
      DNS_TERTIARY_ENABLED: true,
      DNS_TERTIARY_STRATEGY: 'doh-primary',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result).toBeDefined();
    expect(result?.secondaryProvider).toBeDefined();
    expect(result?.tertiaryProvider).toBeUndefined();
  });

  it('threads DNS_CONSENSUS_REQUIRED_AVAILABLE into the consensus config', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
      DNS_TERTIARY_ENABLED: true,
      DNS_TERTIARY_STRATEGY: 'native',
      DNS_CONSENSUS_REQUIRED_AVAILABLE: 2,
    });
    const result = buildDnsConsensusConfig(config);
    expect(result?.requiredAvailable).toBe(2);
  });

  it('defaults requiredAvailable to 1', () => {
    const config = makeConfig({
      DNS_CONSENSUS_ENABLED: true,
      DNS_LOOKUP_STRATEGY: 'dot-only',
      DNS_CONSENSUS_STRATEGY: 'doh-only',
      DNS_TERTIARY_ENABLED: true,
      DNS_TERTIARY_STRATEGY: 'native',
    });
    const result = buildDnsConsensusConfig(config);
    expect(result?.requiredAvailable).toBe(1);
  });
});

describe('parseRdapBootstrapUrls', () => {
  it('parses a JSON array of plain URL strings', () => {
    expect(
      parseRdapBootstrapUrls(
        '["https://rdap.org/domain/","https://rdap.verisign.com/com/domain/"]',
      ),
    ).toEqual([
      { url: 'https://rdap.org/domain/' },
      { url: 'https://rdap.verisign.com/com/domain/' },
    ]);
  });

  it('parses scoped {url, tlds} entries', () => {
    expect(
      parseRdapBootstrapUrls(
        '[{"url":"https://rdap.verisign.com/com/domain/","tlds":["com","net"]}]',
      ),
    ).toEqual([{ url: 'https://rdap.verisign.com/com/domain/', tlds: ['com', 'net'] }]);
  });

  it('supports a mix of strings and scoped entries', () => {
    expect(
      parseRdapBootstrapUrls(
        '["https://rdap.org/domain/",{"url":"https://rdap.nic.io/domain/","tlds":["io"]}]',
      ),
    ).toEqual([
      { url: 'https://rdap.org/domain/' },
      { url: 'https://rdap.nic.io/domain/', tlds: ['io'] },
    ]);
  });

  it('drops empty tlds arrays back to a universal entry', () => {
    expect(parseRdapBootstrapUrls('[{"url":"https://rdap.org/domain/","tlds":[]}]')).toEqual([
      { url: 'https://rdap.org/domain/' },
    ]);
  });

  it('returns an empty list for undefined or invalid JSON', () => {
    expect(parseRdapBootstrapUrls(undefined)).toEqual([]);
    expect(parseRdapBootstrapUrls('not json')).toEqual([]);
    expect(parseRdapBootstrapUrls('{"url":"https://rdap.org/domain/"}')).toEqual([]);
  });
});

describe('validateConsensusStrategyDisjointness', () => {
  it('accepts disjoint strategies', () => {
    expect(validateConsensusStrategyDisjointness(true, 'doh-primary', 'dot-only')).toBe(true);
  });

  it('rejects identical strategies when consensus is enabled', () => {
    // A secondary resolver using the same resolvers provides no independent
    // opinion — the 2-of-3 consensus would be a rubber stamp.
    expect(validateConsensusStrategyDisjointness(true, 'dot-only', 'dot-only')).toBe(false);
  });

  it('ignores the check when consensus is disabled', () => {
    expect(validateConsensusStrategyDisjointness(false, 'dot-only', 'dot-only')).toBe(true);
  });
});

// Regression: the RDAP circuit breaker state must be shared across
// containers in cloud mode (api/worker/scheduler). In single-process
// deployments the in-memory breaker is used; with Redis connected, the
// distributed (Redis/Lua) breaker takes over for both the global and the
// per-server circuits. This locks the decision at the factory boundary.
describe('buildRdapCircuitBreakers', () => {
  function makeMockRedisClient(): RedisClient {
    return {
      isConnected: true,
      keyPrefix: 'dominus:',
      prefixed: (key: string) => `dominus:${key}`,
      withRedis: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
      client: {} as never,
      ping: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as RedisClient;
  }

  it('returns in-memory breakers when no Redis client is connected', () => {
    const { global, perServer } = buildRdapCircuitBreakers(undefined);

    expect(global).toBeInstanceOf(CircuitBreaker);
    expect(perServer('registry.example', {})).toBeInstanceOf(CircuitBreaker);
  });

  it('returns distributed breakers when a Redis client is connected', () => {
    const { global, perServer } = buildRdapCircuitBreakers(makeMockRedisClient());

    expect(global).toBeInstanceOf(DistributedCircuitBreaker);
    expect(perServer('registry.example', {})).toBeInstanceOf(DistributedCircuitBreaker);
  });

  it('keeps the per-server policy when the factory builds distributed breakers', () => {
    const client = makeMockRedisClient();
    const { perServer } = buildRdapCircuitBreakers(client);

    const breaker = perServer('rdap.org', {}) as DistributedCircuitBreaker;
    expect(breaker.cooldownMs).toBe(60_000);
  });
});

// Regression: the DNS layer refuses to persist Unknown results
// (node-dns-provider "never persist unknown"), but the RDAP cached layer
// persisted everything unconditionally — a transient registry failure would
// freeze a domain's status for the full PROVIDER_CACHE_TTL_DAYS. This locks
// the predicate decision at the factory boundary: Unknown/Error results must
// never reach the provider_cache table; only definitive verdicts may be
// cached.
describe('isRdapResultCacheable', () => {
  const definitive: DomainStatus[] = [
    DomainStatus.Available,
    DomainStatus.Registered,
    DomainStatus.Premium,
  ];
  const transient: DomainStatus[] = [DomainStatus.Unknown, DomainStatus.Error];

  for (const status of definitive) {
    it(`returns true for ${status} results`, () => {
      expect(
        isRdapResultCacheable({ domain: 'example.com', status, isPremium: false, checkedAt: '' }),
      ).toBe(true);
    });
  }

  for (const status of transient) {
    it(`returns false for ${status} results`, () => {
      expect(
        isRdapResultCacheable({ domain: 'example.com', status, isPremium: false, checkedAt: '' }),
      ).toBe(false);
    });
  }
});

// Freshness mirror of the DNS stale-Available window: an Available verdict
// must not survive the full PROVIDER_CACHE_TTL_DAYS when the domain may have
// flipped to registered in the meantime (a false positive is a wasted buy
// recommendation). Registered is the conservative outcome and stays cached.
describe('isRdapResultStale', () => {
  const HOURS = 24;

  it('is stale when an Available verdict is older than the window', () => {
    const old = new Date(Date.now() - (HOURS + 1) * 3_600_000).toISOString();
    expect(
      isRdapResultStale(
        { domain: 'example.com', status: DomainStatus.Available, isPremium: false, checkedAt: old },
        HOURS,
      ),
    ).toBe(true);
  });

  it('is fresh when an Available verdict is within the window', () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      isRdapResultStale(
        {
          domain: 'example.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: recent,
        },
        HOURS,
      ),
    ).toBe(false);
  });

  it('is never stale for Registered verdicts (conservative outcome)', () => {
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    expect(
      isRdapResultStale(
        {
          domain: 'example.com',
          status: DomainStatus.Registered,
          isPremium: false,
          checkedAt: old,
        },
        HOURS,
      ),
    ).toBe(false);
  });

  it('is never stale for transient statuses (they are not cached anyway)', () => {
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    for (const status of [DomainStatus.Unknown, DomainStatus.Error]) {
      expect(
        isRdapResultStale(
          { domain: 'example.com', status, isPremium: false, checkedAt: old },
          HOURS,
        ),
      ).toBe(false);
    }
  });

  it('treats an unparseable checkedAt as fresh', () => {
    expect(
      isRdapResultStale(
        {
          domain: 'example.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: 'nope',
        },
        HOURS,
      ),
    ).toBe(false);
  });
});

function fakeRedis(): RedisClient {
  return {
    isConnected: true,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
    withRedis: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
    client: {} as never,
    ping: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as RedisClient;
}

// Regression (ADR-0044): the 2-of-3 consensus secondary must run against its
// own rate-limit budget. Sharing the primary DNS bucket would let a heavy
// Primary run starve the very gate that is supposed to fail the run closed,
// and the two providers' budgets would count against each other.
describe('buildRateLimiters DNS consensus budget', () => {
  it('returns a dedicated in-memory limiter separate from the primary DNS bucket', () => {
    const rl = buildRateLimiters(makeConfig());
    expect(rl.dnsConsensus).toBeDefined();
    expect(rl.dnsConsensus).not.toBe(rl.dns);
    expect((rl.dnsConsensus as RateLimiter).maxTokens).toBe(20);
  });

  it('honours the DNS_CONSENSUS_RATE_LIMIT_TOKENS override for the consensus budget', () => {
    const config = makeConfig({ DNS_CONSENSUS_RATE_LIMIT_TOKENS: 7 });
    const rl = buildRateLimiters(config);
    expect((rl.dnsConsensus as RateLimiter).maxTokens).toBe(7);
    // The primary budget is untouched by the consensus override.
    expect((rl.dns as RateLimiter).maxTokens).toBe(20);
  });

  it('returns a distinct Redis limiter with its own namespace in cloud mode', () => {
    const rl = buildRateLimiters(makeConfig(), fakeRedis());
    expect(rl.dnsConsensus).toBeInstanceOf(RedisRateLimiter);
    expect(rl.dnsConsensus).not.toBe(rl.dns);
    expect((rl.dnsConsensus as RedisRateLimiter).metrics().namespace).toBe('dns-consensus');
  });

  it('buildConsensusRateLimiter cycles on DNS_CONSENSUS_* tuning when no redis is connected', () => {
    const config = makeConfig({ DNS_CONSENSUS_RATE_LIMIT_TOKENS: 3 });
    const limiter = buildConsensusRateLimiter(config);
    expect((limiter as RateLimiter).maxTokens).toBe(3);
  });
});

// Regression (ADR-0050): the 2-of-2 RDAP consensus gate was implemented and
// unit-tested at the stage level but composition-root never passed a
// consensusConfig, so it never ran in production — the same wiring failure
// the DNS consensus had (see buildDnsConsensusConfig regression above).
// This locks in the factory boundary: the second leg is a real provider
// pinned to the independent RDAP_CONSENSUS_ENDPOINT.
// Regression (ADR-0052): WHOIS is the last provider without a distributed
// rate-limit budget. Every other network channel (rdap/uspto/euipo/wayback/
// dns/dns-consensus/rdap-consensus) gets a Redis namespace in cloud mode;
// WHOIS ran on per-process in-memory buckets, so N replicas multiplied the
// registry-query rate N× and per-tenant fair share (ADR-0041) could not be
// enforced. These tests lock the parity boundary before wiring.
describe('WHOIS distributed rate-limit parity (ADR-0052)', () => {
  it('exposes a whois budget in buildRateLimiters, in-memory when no Redis', () => {
    const rl = buildRateLimiters(makeConfig());
    expect(rl.whois).toBeDefined();
    expect(rl.whois).toBeInstanceOf(RateLimiter);
    expect((rl.whois as RateLimiter).maxTokens).toBe(1);
    expect(rl.whois).not.toBe(rl.dns);
  });

  it('uses a dedicated Redis namespace in cloud mode', () => {
    const rl = buildRateLimiters(makeConfig(), fakeRedis());
    expect(rl.whois).toBeInstanceOf(RedisRateLimiter);
    expect((rl.whois as RedisRateLimiter).metrics().namespace).toBe('whois');
  });

  it('buildWhoisRateLimiter honours the WHOIS_RATE_LIMIT_TOKENS override', () => {
    const limiter = buildWhoisRateLimiter(makeConfig({ WHOIS_RATE_LIMIT_TOKENS: 3 }));
    expect((limiter as RateLimiter).maxTokens).toBe(3);
  });

  it('buildWhoisRateLimiter becomes a Redis limiter when Redis is connected', () => {
    const limiter = buildWhoisRateLimiter(makeConfig({ WHOIS_RATE_LIMIT_TOKENS: 4 }), fakeRedis());
    expect(limiter).toBeInstanceOf(RedisRateLimiter);
    expect((limiter as RedisRateLimiter).metrics().namespace).toBe('whois');
    expect((limiter as RedisRateLimiter).metrics().maxTokens).toBe(4);
  });

  it('buildWhoisPerTldRateLimiters maps overrides to per-TLD Redis namespaces', () => {
    const limiters = buildWhoisPerTldRateLimiters(
      makeConfig({
        WHOIS_RATE_LIMIT_OVERRIDES: '{"de":{"tokensPerInterval":1,"intervalMs":20000}}',
      }),
      fakeRedis(),
    );
    const de = limiters['.de'] as RedisRateLimiter;
    expect(de).toBeInstanceOf(RedisRateLimiter);
    expect(de.metrics().namespace).toBe('whois:de');
    expect(de.metrics().maxTokens).toBe(1);
  });

  it('buildWhoisPerTldRateLimiters falls back to in-memory buckets without Redis', () => {
    const limiters = buildWhoisPerTldRateLimiters(
      makeConfig({
        WHOIS_RATE_LIMIT_OVERRIDES: '{"de":{"tokensPerInterval":1,"intervalMs":20000}}',
      }),
    );
    const de = limiters['.de'] as RateLimiter;
    expect(de).toBeInstanceOf(RateLimiter);
    expect(de.maxTokens).toBe(1);
    expect((de as RateLimiter).metrics().intervalMs).toBe(20000);
  });

  it('buildWhoisPerTldRateLimiters returns nothing when no overrides are set', () => {
    expect(buildWhoisPerTldRateLimiters(makeConfig())).toEqual({});
    expect(buildWhoisPerTldRateLimiters(makeConfig(), fakeRedis())).toEqual({});
  });
});

describe('createRdapConsensusConfig (ADR-0050)', () => {
  it('returns undefined when RDAP_CONSENSUS_ENABLED is explicitly false', () => {
    const config = makeConfig({ RDAP_CONSENSUS_ENABLED: false });
    expect(createRdapConsensusConfig(config)).toBeUndefined();
  });

  it('returns undefined with a prominent log when enabled but the endpoint is empty', () => {
    const config = makeConfig({ RDAP_CONSENSUS_ENABLED: true, RDAP_CONSENSUS_ENDPOINT: '' });
    expect(createRdapConsensusConfig(config)).toBeUndefined();
  });

  it('builds a secondary provider pinned to the independent endpoint', () => {
    const config = makeConfig({
      RDAP_CONSENSUS_ENABLED: true,
      RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
    });
    const result = createRdapConsensusConfig(config);
    expect(result).toBeDefined();
    expect(result?.secondaryOrigin).toBe('https://rdap.secondary.example.com/');
    expect(typeof result?.secondaryProvider.confirm).toBe('function');
  });

  it('threads the degraded ratio/min and concurrency tuning into the config', () => {
    const config = makeConfig({
      RDAP_CONSENSUS_ENABLED: true,
      RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
      RDAP_CONSENSUS_DEGRADED_RATIO: 0.3,
      RDAP_CONSENSUS_DEGRADED_MIN: 25,
      RDAP_CONSENSUS_BULK_CONCURRENCY: 3,
    });
    const result = createRdapConsensusConfig(config);
    expect(result?.degradedRatio).toBe(0.3);
    expect(result?.degradedMin).toBe(25);
    expect(result?.consensusConcurrency).toBe(3);
  });

  it('wires the WHOIS rescue leg flag through the stage config (ADR-0051)', () => {
    const on = createRdapConsensusConfig(
      makeConfig({
        RDAP_CONSENSUS_ENABLED: true,
        RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
        RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: true,
      }),
    );
    expect(on?.rescueWhoisEnabled).toBe(true);

    const off = createRdapConsensusConfig(
      makeConfig({
        RDAP_CONSENSUS_ENABLED: true,
        RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
        RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: false,
      }),
    );
    expect(off?.rescueWhoisEnabled).toBe(false);
  });

  it('passes RDAP_CONSENSUS_TIMEOUT_MS to the consensus second provider (fixes the dead knob)', () => {
    const fromConfig = vi.spyOn(FailoverRdapProvider, 'fromConfig').mockReturnValue({
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Available,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      }),
    } as unknown as FailoverRdapProvider);
    afterEach(() => fromConfig.mockRestore());

    const config = makeConfig({
      RDAP_CONSENSUS_ENABLED: true,
      RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
      RDAP_CONSENSUS_TIMEOUT_MS: 7333,
    });
    createRdapConsensusConfig(config);

    const args = fromConfig.mock.calls[0]!;
    expect(args[args.length - 1]).toBe(7333);
  });
});

describe('probeRdapConsensusEndpoint (ADR-0051)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it('is a no-op when the consensus gate is off', async () => {
    const provider: RdapProvider = { name: 'probe', confirm: vi.fn() };
    await probeRdapConsensusEndpoint(makeConfig({ RDAP_CONSENSUS_ENABLED: false }), provider);
    expect(provider.confirm).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the second leg answers', async () => {
    const provider: RdapProvider = {
      name: 'probe',
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Registered,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      }),
    };
    await expect(
      probeRdapConsensusEndpoint(
        makeConfig({
          RDAP_CONSENSUS_ENABLED: true,
          RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
        }),
        provider,
      ),
    ).resolves.toBeUndefined();
  });

  it('logs an error but never rejects when the second leg is unreachable', async () => {
    const errorSpy = vi.spyOn(getLogger(), 'error').mockImplementation(() => {
      return undefined as never;
    });
    const provider: RdapProvider = {
      name: 'probe',
      confirm: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    await expect(
      probeRdapConsensusEndpoint(
        makeConfig({
          RDAP_CONSENSUS_ENABLED: true,
          RDAP_CONSENSUS_ENDPOINT: 'https://rdap.secondary.example.com/',
        }),
        provider,
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildRateLimiters RDAP consensus budget (ADR-0050)', () => {
  it('returns a dedicated in-memory limiter separate from the primary RDAP bucket', () => {
    const rl = buildRateLimiters(makeConfig());
    expect(rl.rdapConsensus).toBeDefined();
    expect(rl.rdapConsensus).not.toBe(rl.rdap);
    expect((rl.rdapConsensus as RateLimiter).maxTokens).toBe(5);
  });

  it('honours the RDAP_CONSENSUS_RATE_LIMIT_TOKENS override for the consensus budget', () => {
    const config = makeConfig({ RDAP_CONSENSUS_RATE_LIMIT_TOKENS: 7 });
    const rl = buildRateLimiters(config);
    expect((rl.rdapConsensus as RateLimiter).maxTokens).toBe(7);
    // The primary budget is untouched by the consensus override.
    expect((rl.rdap as RateLimiter).maxTokens).toBe(10);
  });

  it('returns a distinct Redis limiter with its own namespace in cloud mode', () => {
    const rl = buildRateLimiters(makeConfig(), fakeRedis());
    expect(rl.rdapConsensus).toBeInstanceOf(RedisRateLimiter);
    expect(rl.rdapConsensus).not.toBe(rl.rdap);
    expect((rl.rdapConsensus as RedisRateLimiter).metrics().namespace).toBe('rdap-consensus');
  });
});

describe('buildAnonBudgetGate (ADR-0056)', () => {
  it('returns a disabled gate when the anonymous trademark budget is off', () => {
    const gate = buildAnonBudgetGate(makeConfig({ ANON_TRADEMARK_BUDGET_ENABLED: false }));
    expect(gate.enabled).toBe(false);
    expect(gate.maxTokens).toBe(-1);
  });

  it('builds an in-memory budget when enabled without Redis', async () => {
    const gate = buildAnonBudgetGate(makeConfig({ ANON_TRADEMARK_BUDGET_ENABLED: true }));
    expect(gate.enabled).toBe(true);
    expect(gate.limiter).toBeInstanceOf(RateLimiter);
    await expect(gate.tryAcquire()).resolves.toBe(true);
  });

  it('honours the token override for the in-memory budget', () => {
    const gate = buildAnonBudgetGate(
      makeConfig({
        ANON_TRADEMARK_BUDGET_ENABLED: true,
        ANON_TRADEMARK_RATE_LIMIT_TOKENS: 7,
      }),
    );
    expect(gate.maxTokens).toBe(7);
  });

  it('builds a distributed budget on the anon-trademark namespace in cloud mode', () => {
    const gate = buildAnonBudgetGate(
      makeConfig({ ANON_TRADEMARK_BUDGET_ENABLED: true }),
      fakeRedis(),
    );
    expect(gate.enabled).toBe(true);
    expect(gate.limiter).toBeInstanceOf(RedisRateLimiter);
    expect((gate.limiter as RedisRateLimiter).metrics().namespace).toBe('anon-trademark');
  });
});
