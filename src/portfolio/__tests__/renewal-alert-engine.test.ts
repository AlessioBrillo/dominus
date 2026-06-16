import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import { RenewalAlertEngine } from '../renewal-alert-engine.js';
import { ConsoleNotifier } from '../../notifiers/console-notifier.js';
import type { Config } from '../../config.js';

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    DATABASE_BUSY_TIMEOUT: 30000,
    PORT: 3000,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_HOLDING_YEARS: 3,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    KEYWORD_DATA_PATH: undefined,
    KEYWORD_PROVIDER: 'manual',
    COMPS_DATA_PATH: undefined,
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
    WHOIS_LOOKUP_TIMEOUT: 10_000,
    RDAP_RATE_LIMIT_TOKENS: 10,
    RDAP_RATE_LIMIT_INTERVAL_MS: 1000,
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
    NOTIFIER_DESKTOP_ENABLED: false,
    NOTIFIER_WEBHOOK_URL: undefined,
    NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
    NOTIFIER_TELEGRAM_CHAT_ID: undefined,
    PIPELINE_TIMEOUT_MS: 3_600_000,
    SCHEDULER_ENABLED: false,
    SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
    SCHEDULER_RESCORE_CRON: '0 9 * * 1',
    SCHEDULER_PRUNE_CRON: '0 10 1 * *',
    SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
    SCHEDULER_WARMUP_MS: 5000,
    BACKUP_DIR: './data/backup',
    BACKUP_RETENTION_DAYS: 30,
    SCHEDULER_BACKUP_CRON: '0 4 * * *',
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
    SCORING_CONFIDENCE_PER_SIGNAL: 0.3,
    SCORING_CONFIDENCE_CAP: 0.8,
    TLD_BONUSES_PATH: undefined,
    DEFAULT_KEYWORD_TLD: '.com',
    TRADEMARK_MIN_TOKEN_LENGTH_FUZZY: 4,
    TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING: 3,
    TRADEMARK_MAX_LEVENSHTEIN: 1,
    PROVIDER_CACHE_TTL_DAYS: 7,
    TRADEMARK_BATCH_CONCURRENCY: 3,
    WHOIS_BATCH_CONCURRENCY: 3,
    RESCORE_BATCH_CONCURRENCY: 5,
    REQUEST_TIMEOUT_MS: 30000,
    FRONTEND_DIST_PATH: './frontend/dist',
    FRONTEND_BASE_PATH: '',
    NAMEBIO_API_KEY: undefined,
    SCORING_INTRINSIC_QUALITY_INFLUENCE: 0.12,
    DROP_METHOD: 'threshold',
    DROP_NPV_DISCOUNT_RATE: 0.05,
    DROP_NPV_HORIZON_YEARS: 5,
    FILE_REGISTRAR_CONFIG: undefined,
    WORKER_ENABLED: false,
    WORKER_CONCURRENCY: 2,
    JOB_QUEUE_POLL_INTERVAL_MS: 1000,
    JOB_MAX_RUNNING_AGE_MS: 300000,
    ...overrides,
  };
}

describe('RenewalAlertEngine', () => {
  let db: Database.Database;
  let portfolioRepo: PortfolioRepository;
  let alertRepo: RenewalAlertRepository;
  let engine: RenewalAlertEngine;
  let config: Config;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    portfolioRepo = new PortfolioRepository(db);
    alertRepo = new RenewalAlertRepository(db);
    config = makeConfig();
    engine = new RenewalAlertEngine(portfolioRepo, alertRepo, config, [new ConsoleNotifier()]);
  });

  it('generates no alerts when portfolio is empty', async () => {
    const result = await engine.checkAll();
    expect(result.generated).toBe(0);
    expect(result.alerts).toEqual([]);
  });

  it('creates warning alerts for domains within warning horizon', async () => {
    portfolioRepo.insert({
      domain: 'soon.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(25),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const result = await engine.checkAll();
    expect(result.generated).toBe(1);
    expect(result.alerts[0]?.alertType).toBe('renewal_imminent');
    expect(result.alerts[0]?.severity).toBe('warning');
  });

  it('creates critical alerts for domains within critical horizon', async () => {
    portfolioRepo.insert({
      domain: 'urgent.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(3),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const result = await engine.checkAll();
    expect(result.generated).toBe(1);
    expect(result.alerts[0]?.alertType).toBe('renewal_critical');
    expect(result.alerts[0]?.severity).toBe('critical');
  });

  it('creates past-due alerts for domains past renewal date', async () => {
    portfolioRepo.insert({
      domain: 'expired.com',
      tld: 'com',
      acquiredAt: '2024-01-01',
      renewalDate: daysFromNow(-5),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const result = await engine.checkAll();
    expect(result.generated).toBe(1);
    expect(result.alerts[0]?.alertType).toBe('renewal_past_due');
    expect(result.alerts[0]?.severity).toBe('critical');
  });

  it('does not create alerts for domains far from renewal', async () => {
    portfolioRepo.insert({
      domain: 'safe.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(100),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const result = await engine.checkAll();
    expect(result.generated).toBe(0);
  });

  it('upgrades alert severity when domain gets closer to renewal', async () => {
    portfolioRepo.insert({
      domain: 'closer.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(25),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const first = await engine.checkAll();
    expect(first.alerts[0]?.alertType).toBe('renewal_imminent');

    // Simulate time passing â€” update renewal date to be closer
    portfolioRepo.delete('closer.com');
    portfolioRepo.insert({
      domain: 'closer.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(3),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const second = await engine.checkAll();
    expect(second.alerts[0]?.alertType).toBe('renewal_critical');
  });

  it('handles multiple domains with mixed renewal windows', async () => {
    portfolioRepo.insert({
      domain: 'warning.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(20),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });
    portfolioRepo.insert({
      domain: 'critical.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(5),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });
    portfolioRepo.insert({
      domain: 'safe.com',
      tld: 'com',
      acquiredAt: '2025-01-01',
      renewalDate: daysFromNow(90),
      acquisitionCost: 10,
      renewalCost: 15,
      registrar: 'test',
    });

    const result = await engine.checkAll();
    expect(result.generated).toBe(2);
    const types = result.alerts.map((a) => a.alertType).sort();
    expect(types).toEqual(['renewal_critical', 'renewal_imminent']);
  });
});
