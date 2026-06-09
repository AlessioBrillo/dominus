import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from '../scheduler-service.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';
import type { Config } from '../../config.js';
import { resetConfig } from '../../config.js';
import { resetLogger } from '../../logger.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_HOLDING_YEARS: 3,
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

function makeMockAlertEngine(): RenewalAlertEngine {
  return {
    checkAll: vi.fn().mockResolvedValue({ generated: 0, alerts: [] }),
  } as unknown as RenewalAlertEngine;
}

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

  it('reports initial status with no runs after start', () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    const status = scheduler.getStatus();
    expect(status).toHaveLength(1); // renewal-check registered in start
    expect(status[0]?.name).toBe('renewal-check');
    expect(status[0]?.lastRunAt).toBeNull();
    scheduler.stop();
  });

  it('reports status after start includes all registered jobs', () => {
    const scheduler = new SchedulerService({ config, alertEngine });
    scheduler.start();
    const status = scheduler.getStatus();
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
});
