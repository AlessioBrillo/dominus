// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { WatchlistRepository } from '../../db/repositories/watchlist-repository.js';
import { WatchlistService } from '../watchlist-service.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { Notifier } from '../../notifiers/notifier.js';
import type { Config } from '../../config.js';
import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import { UsageRepository } from '../../db/repositories/usage-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import { UsageMeterService } from '../../services/usage-meter-service.js';
import { PipelineUsageEnforcer } from '../../services/pipeline-usage-enforcer.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    DATABASE_BUSY_TIMEOUT: 30000,
    PORT: 3000,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    SCORING_HOLDING_YEARS: 3,
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
    DNS_PRIVACY_MODE: false,
    DNS_DOH_ENDPOINT: 'https://cloudflare-dns.com/dns-query',
    DNS_DOH_MAX_CONNECTIONS: 64,
    DNS_DNSSEC_VALIDATION_ENABLED: true,
    DNS_NATIVE_DNSSEC_ENABLED: true,
    DNS_CONSENSUS_RATE_LIMIT_TOKENS: 20,
    DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_BULK_CONCURRENCY: 20,
    DNS_CONSENSUS_RUNTIME_VALIDATION: false,
    DNS_CONSENSUS_RUNTIME_VALIDATION_MODE: 'permissive',
    DNS_CONSENSUS_TEST_DOMAIN: 'example.com',
    DNS_CONSENSUS_VALIDATION_TIMEOUT_MS: 2000,
    DNS_TERTIARY_ENABLED: false,
    DNS_TERTIARY_STRATEGY: 'native',
    DNS_TERTIARY_NAMESERVERS: undefined,
    DNS_TERTIARY_RATE_LIMIT_TOKENS: 10,
    DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS: 1000,
    DNS_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: 3,
    DNS_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    DNS_TERTIARY_BULK_CONCURRENCY: 10,
    DNS_CONSENSUS_REQUIRED_AVAILABLE: 1,
    DNS_CONSENSUS_PRIORITY_RESERVED_RATIO: 0.3,
    DNS_CONSENSUS_FALLBACK_STRATEGY: 'doh-alternate',
    DNS_CONSENSUS_ON_FAILURE: 'degrade',
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
    WATCHLIST_RDAP_DELAY_MS: 50,
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
    RDAP_MAX_RESPONSE_BYTES: 1048576,
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
    RDAP_CONSENSUS_TERTIARY_ENABLED: false,
    RDAP_TERTIARY_ENDPOINT: '',
    RDAP_TERTIARY_RATE_LIMIT_TOKENS: 3,
    RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS: 1000,
    RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: 1,
    RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    RDAP_TERTIARY_BULK_CONCURRENCY: 5,
    RDAP_TERTIARY_TIMEOUT_MS: 10000,

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
    AUTH0_SESSION_TTL_HOURS: 8,
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
    DNS_USE_DEDICATED_RESOLVER: true,
    DNS_DOT_POOL_MAX_QUEUED: 4096,
    RDAP_WHOIS_BUDGET_MS: 1000,
    STAGE_TIMEOUT_BASE_MS: 30_000,
    STAGE_TIMEOUT_PER_CANDIDATE_MS: 200,
    STAGE_TIMEOUT_CAP_MS: 3_600_000,
    STAGE_TIMEOUT_GRACE_MS: 5_000,
    RDAP_CONSENSUS_RESCUE_WHOIS_TLDS: [],
    ...overrides,
  };
}

function makeDnsMock(results: Record<string, DomainStatus>): DnsProvider {
  return {
    name: 'MockDns',
    checkAvailability: vi.fn().mockImplementation((domain: string) => {
      const status = results[domain] ?? DomainStatus.Unknown;
      return Promise.resolve({
        domain,
        status,
        checkedAt: new Date().toISOString(),
      } as DnsCheckResult);
    }),
    checkBulk: vi.fn(),
    clearCache: vi.fn(),
    pruneCache: vi.fn().mockReturnValue(0),
  };
}

function makeRdapMock(results: Record<string, RdapResult>): RdapProvider {
  return {
    name: 'mock-rdap',
    confirm: vi.fn().mockImplementation((domain: string) => {
      const existing = results[domain];
      if (existing) return Promise.resolve(existing);
      return Promise.resolve({
        domain,
        status: DomainStatus.Registered,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      } as RdapResult);
    }),
  };
}

function makeNotifierMock(): Notifier[] {
  const notifier: Notifier = {
    channel: 'console',
    send: vi.fn().mockResolvedValue(undefined),
  };
  return [notifier];
}

function openTestDb(): { db: Database.Database; dbProvider: SqliteProvider } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const dbProvider = new SqliteProvider(db);
  return { db, dbProvider };
}

describe('WatchlistService', () => {
  let dbProvider: SqliteProvider;
  let repo: WatchlistRepository;
  let config: Config;
  let dnsMock: DnsProvider;
  let rdapMock: RdapProvider;
  let notifiers: Notifier[];
  let service: WatchlistService;

  beforeEach(() => {
    const opened = openTestDb();
    dbProvider = opened.dbProvider;
    repo = new WatchlistRepository(dbProvider);
    config = makeConfig();
    dnsMock = makeDnsMock({});
    rdapMock = makeRdapMock({});
    notifiers = makeNotifierMock();
    service = new WatchlistService(repo, dnsMock, rdapMock, notifiers, config);
  });

  describe('add', () => {
    it('adds a domain to the watchlist', async () => {
      const entry = await service.add('example.com');
      expect(entry.domain).toBe('example.com');
      expect(entry.tld).toBe('.com');
      expect(entry.notified).toBe(0);
    });

    it('accepts optional notes', async () => {
      const entry = await service.add('test.io', 'interesting domain');
      expect(entry.domain).toBe('test.io');
      expect(entry.notes).toBe('interesting domain');
    });

    it('rejects duplicate domain', async () => {
      await service.add('example.com');
      await expect(service.add('example.com')).rejects.toThrow();
    });
  });

  describe('remove', () => {
    it('removes an existing entry', async () => {
      await service.add('example.com');
      expect(await service.remove('example.com')).toBe(true);
      expect(await service.get('example.com')).toBeNull();
    });

    it('returns false for non-existing entry', async () => {
      expect(await service.remove('nonexistent.com')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all entries', async () => {
      await service.add('a.com');
      await service.add('b.io');
      expect(await service.list()).toHaveLength(2);
    });

    it('returns empty array when none', async () => {
      expect(await service.list()).toHaveLength(0);
    });
  });

  describe('get', () => {
    it('returns entry by domain', async () => {
      await service.add('example.com');
      const entry = await service.get('example.com');
      expect(entry).not.toBeNull();
      expect(entry!.domain).toBe('example.com');
    });

    it('returns null for missing domain', async () => {
      expect(await service.get('missing.com')).toBeNull();
    });
  });

  describe('poll', () => {
    it('does nothing when watchlist is empty', async () => {
      const result = await service.poll();
      expect(result.checked).toBe(0);
      expect(result.available).toBe(0);
    });

    it('marks registered domains as checked without notifying', async () => {
      service.add('registered.com');
      const dnsMock2 = makeDnsMock({ 'registered.com': DomainStatus.Registered });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(1);
      expect(result.available).toBe(0);
      expect(result.notified).toBe(0);

      const entry = await repo.findByDomain('registered.com');
      expect(entry!.lastStatus).toBe(DomainStatus.Registered);
      expect(entry!.lastCheckedAt).not.toBeNull();
    });

    it('notifies when domain becomes available', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(1);
      expect(result.available).toBe(1);
      expect(result.notified).toBe(1);

      const entry = await repo.findByDomain('available.com');
      expect(entry!.notified).toBe(1);
      expect(entry!.lastStatus).toBe(DomainStatus.Available);

      expect((notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      const notification = (notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(notification.domain).toBe('available.com');
      expect(notification.alertType).toBe(AlertType.DomainAvailable);
      expect(notification.severity).toBe(AlertSeverity.Success);
    });

    it('does not notify twice for the same availability', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      await svc.poll();
      const result2 = await svc.poll();
      expect(result2.checked).toBe(0);
      expect(result2.available).toBe(0);
    });

    it('dry run does not persist notification', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      const result = await svc.poll(true);
      expect(result.available).toBe(1);
      expect(result.notified).toBe(0);

      const entry = await repo.findByDomain('available.com');
      expect(entry!.notified).toBe(0);
      expect((notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('handles DNS check failure gracefully', async () => {
      service.add('errored.com');
      const dnsMock2: DnsProvider = {
        name: 'MockDns2',
        checkAvailability: vi.fn().mockRejectedValue(new Error('DNS timeout')),
        checkBulk: vi.fn(),
        clearCache: vi.fn(),
        pruneCache: vi.fn().mockReturnValue(0),
      };
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(0);
      expect(result.errors).toBe(1);
    });

    it('processes multiple entries with rate limiting delay', async () => {
      service.add('a.com');
      service.add('b.com');
      service.add('c.com');

      const dnsMock2 = makeDnsMock({
        'a.com': DomainStatus.Registered,
        'b.com': DomainStatus.Registered,
        'c.com': DomainStatus.Registered,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const start = Date.now();
      const result = await svc.poll();
      const elapsed = Date.now() - start;

      expect(result.checked).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(100); // 2 delays ÃƒÆ’Ã¢â‚¬â€ 50ms
    });
  });

  describe('usage guard (domains_tracked)', () => {
    const PERIOD = UsageMeterService.periodStart(new Date().toISOString());

    async function makeGuardedService(enabled: boolean): Promise<{
      svc: WatchlistService;
      usageRepo: UsageRepository;
    }> {
      const usageRepo = new UsageRepository(dbProvider);
      const subRepo = new SubscriptionRepository(dbProvider);
      await subRepo.ensureDefault('default');
      const usageService = new UsageMeterService(usageRepo, subRepo);
      const enforcer = new PipelineUsageEnforcer(usageService, enabled);
      return {
        svc: new WatchlistService(repo, dnsMock, rdapMock, notifiers, config, enforcer),
        usageRepo,
      };
    }

    it('meters one tracked domain per add when enforcement is enabled', async () => {
      const { svc, usageRepo } = await makeGuardedService(true);
      await svc.add('a.com');
      await svc.add('b.com');
      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(2);
    });

    it('rejects the add when the domains_tracked allowance is exhausted', async () => {
      const usageRepo = new UsageRepository(dbProvider);
      const subRepo = new SubscriptionRepository(dbProvider);
      await subRepo.ensureDefault('default');
      const { svc } = await makeGuardedService(true);
      await new UsageMeterService(usageRepo, subRepo).record(
        'default',
        'domains_tracked',
        25,
        PERIOD,
      );
      await expect(svc.add('c.com')).rejects.toThrow(/usage limit exceeded/i);
    });

    it('does not record when enforcement is disabled', async () => {
      const { svc, usageRepo } = await makeGuardedService(false);
      await svc.add('d.com');
      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(0);
    });

    it('refunds the metered unit when the insert fails (duplicate add)', async () => {
      const { svc, usageRepo } = await makeGuardedService(true);
      await svc.add('a.com');
      await expect(svc.add('a.com')).rejects.toThrow(/unique constraint/i);

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(1);
    });

    it('does not meter when skipUsageMeter is set (mandated bookkeeping)', async () => {
      const { svc, usageRepo } = await makeGuardedService(true);
      await svc.add('purchased.com', undefined, { skipUsageMeter: true });

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(0);
    });
  });
});
