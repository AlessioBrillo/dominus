// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService, cronFireSlotLockName } from '../scheduler-service.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';
import type { PortfolioRdapService } from '../../portfolio/portfolio-rdap-service.js';
import type { JobQueueService } from '../../app/job-queue-service.js';
import type { LockProvider } from '../../types/lock.js';
import type { Config } from '../../config.js';
import { resetConfig } from '../../config.js';
import { resetLogger } from '../../logger.js';

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
    DNS_CONSENSUS_RATE_LIMIT_TOKENS: 20,
    DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
    DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
    DNS_CONSENSUS_BULK_CONCURRENCY: 20,
    DNS_CONSENSUS_RUNTIME_VALIDATION: false,
    DNS_TERTIARY_ENABLED: false,
    DNS_TERTIARY_STRATEGY: 'native',
    DNS_TERTIARY_NAMESERVERS: undefined,
    DNS_CONSENSUS_REQUIRED_AVAILABLE: 1,
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

function makeMockAlertEngine(): RenewalAlertEngine {
  return {
    checkAll: vi.fn().mockResolvedValue({ generated: 0, alerts: [] }),
  } as unknown as RenewalAlertEngine;
}

function makeLock(acquired: boolean): LockProvider {
  return {
    tryLock: vi.fn().mockResolvedValue(acquired),
    renewLock: vi.fn().mockResolvedValue(true),
    unlock: vi.fn().mockResolvedValue(undefined),
  } as unknown as LockProvider;
}

function makeJobQueue(): JobQueueService {
  return {
    enqueueRenewalCheck: vi.fn().mockResolvedValue('job-1'),
  } as unknown as JobQueueService;
}

const EVERY_SECOND_CRON = '*/1 * * * * *';

describe('SchedulerService', () => {
  let alertEngine: RenewalAlertEngine;
  let config: Config;

  beforeEach(() => {
    resetConfig();
    resetLogger();
    alertEngine = makeMockAlertEngine();
    config = makeConfig();
  });

  it('starts and stops without error', () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('start is idempotent', () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it('reports initial status with no runs after start', async () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    const status = await scheduler.getStatus();
    expect(status).toHaveLength(1); // renewal-check registered in start
    expect(status[0]?.name).toBe('renewal-check');
    expect(status[0]?.lastRunAt).toBeNull();
    scheduler.stop();
  });

  it('reports status after start includes all registered jobs', async () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    const status = await scheduler.getStatus();
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status.some((j) => j.name === 'renewal-check')).toBe(true);
    scheduler.stop();
  });

  it('runOnce triggers the alert engine and returns result', async () => {
    const mockEngine = {
      checkAll: vi.fn().mockResolvedValue({ generated: 3, alerts: [] }),
    } as unknown as RenewalAlertEngine;
    const scheduler = new SchedulerService({ config, alertEngine: mockEngine });
    scheduler.start();

    const result = await scheduler.runOnce('renewal-check');
    expect(result).toContain('3');
    expect(mockEngine.checkAll).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('runOnce throws for unknown job', async () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    await expect(scheduler.runOnce('nonexistent')).rejects.toThrow('Unknown job');
    scheduler.stop();
  });

  // Regression: PortfolioRdapService existed but was never wired to the scheduler,
  // so the weekly renewal-date healthcheck silently never ran (composition-root
  // never passed portfolioHealthcheckService). See src/app/composition-root.ts.
  it('registers portfolio-healthcheck job when portfolioHealthcheckService is provided', async () => {
    const portfolioHealthcheckService = {
      checkExpiring: vi.fn().mockResolvedValue({ checked: 2, updated: 1, errors: 0 }),
    } as unknown as PortfolioRdapService;
    const scheduler = new SchedulerService({ config, alertEngine, portfolioHealthcheckService });
    scheduler.start();
    const status = await scheduler.getStatus();
    expect(status.some((j) => j.name === 'portfolio-healthcheck')).toBe(true);
    scheduler.stop();
  });

  it('omits portfolio-healthcheck job when no service is provided', async () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    const status = await scheduler.getStatus();
    expect(status.some((j) => j.name === 'portfolio-healthcheck')).toBe(false);
    scheduler.stop();
  });

  it('cronFireSlotLockName is scoped to job name and minute slot', () => {
    const a = cronFireSlotLockName('backup', new Date('2026-08-11T08:00:00Z'));
    const sameMinute = cronFireSlotLockName('backup', new Date('2026-08-11T08:00:30Z'));
    const nextMinute = cronFireSlotLockName('backup', new Date('2026-08-11T08:01:00Z'));
    const otherJob = cronFireSlotLockName('prune', new Date('2026-08-11T08:00:00Z'));
    expect(a).toBe('scheduler:fire:backup:2026-08-11T08:00');
    expect(sameMinute).toBe(a);
    expect(nextMinute).not.toBe(a);
    expect(otherJob).not.toBe(a);
  });

  it('skips cron fire when the per-slot lock is not acquired (dedupe across replicas)', async () => {
    const mockEngine = {
      checkAll: vi.fn().mockResolvedValue({ generated: 0, alerts: [] }),
    } as unknown as RenewalAlertEngine;
    const scheduler = new SchedulerService({
      config: { ...config, SCHEDULER_RENEWAL_CHECK_CRON: EVERY_SECOND_CRON },
      alertEngine: mockEngine,
      lock: makeLock(false),
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    scheduler.stop();
    expect(mockEngine.checkAll).not.toHaveBeenCalled();
  });

  it('does not enqueue when the per-slot lock is not acquired', async () => {
    const jobQueue = makeJobQueue();
    const scheduler = new SchedulerService({
      config: { ...config, SCHEDULER_RENEWAL_CHECK_CRON: EVERY_SECOND_CRON },
      alertEngine,
      lock: makeLock(false),
      jobQueueService: jobQueue,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    scheduler.stop();
    expect(jobQueue.enqueueRenewalCheck).not.toHaveBeenCalled();
  });

  it('enqueues on cron fire when the per-slot lock is acquired', async () => {
    const jobQueue = makeJobQueue();
    const scheduler = new SchedulerService({
      config: { ...config, SCHEDULER_RENEWAL_CHECK_CRON: EVERY_SECOND_CRON },
      alertEngine,
      lock: makeLock(true),
      jobQueueService: jobQueue,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    scheduler.stop();
    expect(jobQueue.enqueueRenewalCheck).toHaveBeenCalled();
  });
});
