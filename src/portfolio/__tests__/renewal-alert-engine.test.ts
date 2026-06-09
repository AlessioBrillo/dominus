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
    PORT: 3000,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    KEYWORD_DATA_PATH: undefined,
    COMPS_DATA_PATH: undefined,
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_CLIENT_ID: undefined,
    EUIPO_CLIENT_SECRET: undefined,
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://euipo.europa.eu/api',
    TM_CACHE_TTL_DAYS: 7,
    SCORING_WEIGHTS_OVERRIDE: undefined,
    DNS_BULK_CONCURRENCY: 10,
    WHOIS_LOOKUP_TIMEOUT: 10_000,
    BUY_MAX_ABSOLUTE_CAP: 500,
    HOST: '127.0.0.1',
    RENEWAL_WARNING_DAYS: 30,
    RENEWAL_CRITICAL_DAYS: 7,
    NOTIFIER_DESKTOP_ENABLED: false,
    NOTIFIER_WEBHOOK_URL: undefined,
    NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
    NOTIFIER_TELEGRAM_CHAT_ID: undefined,
    SCHEDULER_ENABLED: false,
    SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
    SCHEDULER_RESCORE_CRON: '0 9 * * 1',
    SCHEDULER_PRUNE_CRON: '0 10 1 * *',
    SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
    WATCHLIST_POLL_INTERVAL_HOURS: 6,
    WATCHLIST_RDAP_DELAY_MS: 200,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    RATE_LIMIT_MAX: 100,
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

    // Simulate time passing — update renewal date to be closer
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
