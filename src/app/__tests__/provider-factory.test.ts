// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import {
  buildDnsConsensusConfig,
  buildRdapCircuitBreakers,
  isRdapResultCacheable,
  isRdapResultStale,
  parseRdapBootstrapUrls,
} from '../provider-factory.js';
import { validateConsensusStrategyDisjointness } from '../../providers/dns/resolver-validator.js';
import type { Config } from '../../config.js';
import { CircuitBreaker } from '../../providers/circuit-breaker.js';
import { DistributedCircuitBreaker, type RedisClient } from '../../providers/redis/index.js';
import { DomainStatus } from '../../types/domain-status.js';

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
    USPTO_TSDR_SEARCH_URL: 'https://tsdr.uspto.gov/tsdr/tmsearch/data',
    USPTO_RATE_LIMIT_TOKENS: 5,
    USPTO_RATE_LIMIT_INTERVAL_MS: 1000,
    EUIPO_RATE_LIMIT_TOKENS: 5,
    EUIPO_RATE_LIMIT_INTERVAL_MS: 1000,
    WHOIS_RATE_LIMIT_TOKENS: 1,
    WHOIS_RATE_LIMIT_INTERVAL_MS: 2000,
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
    SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: '0 2 * * 0',
    WATCHLIST_POLL_INTERVAL_HOURS: 6,
    WATCHLIST_RDAP_DELAY_MS: 200,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    RATE_LIMIT_MAX: 100,
    RDAP_BATCH_CONCURRENCY: 5,
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
    NAMEBIO_API_KEY: undefined,
    SCORING_INTRINSIC_QUALITY_INFLUENCE: 0.12,
    DROP_METHOD: 'threshold',
    DROP_NPV_DISCOUNT_RATE: 0.05,
    DROP_NPV_HORIZON_YEARS: 5,
    FILE_REGISTRAR_CONFIG: undefined,
    WORKER_ENABLED: false,
    USAGE_ENFORCEMENT_ENABLED: false,
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
