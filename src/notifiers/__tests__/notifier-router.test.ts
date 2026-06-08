import { describe, it, expect } from 'vitest';
import { buildNotifiers } from '../notifier-router.js';
import { ConsoleNotifier } from '../console-notifier.js';
import { DesktopNotifier } from '../desktop-notifier.js';
import { WebhookNotifier } from '../webhook-notifier.js';
import { TelegramNotifier } from '../telegram-notifier.js';
import type { Config } from '../../config.js';

const baseConfig: Config = {
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
};

describe('buildNotifiers', () => {
  it('always includes ConsoleNotifier', () => {
    const notifiers = buildNotifiers(baseConfig);
    expect(notifiers.some((n) => n instanceof ConsoleNotifier)).toBe(true);
  });

  it('includes DesktopNotifier when enabled', () => {
    const notifiers = buildNotifiers({ ...baseConfig, NOTIFIER_DESKTOP_ENABLED: true });
    expect(notifiers.some((n) => n instanceof DesktopNotifier)).toBe(true);
  });

  it('excludes DesktopNotifier when disabled', () => {
    const notifiers = buildNotifiers({ ...baseConfig, NOTIFIER_DESKTOP_ENABLED: false });
    expect(notifiers.some((n) => n instanceof DesktopNotifier)).toBe(false);
  });

  it('includes WebhookNotifier when URL is configured', () => {
    const notifiers = buildNotifiers({
      ...baseConfig,
      NOTIFIER_WEBHOOK_URL: 'https://hooks.example.com/alert',
    });
    expect(notifiers.some((n) => n instanceof WebhookNotifier)).toBe(true);
  });

  it('includes TelegramNotifier when both token and chatId are set', () => {
    const notifiers = buildNotifiers({
      ...baseConfig,
      NOTIFIER_TELEGRAM_BOT_TOKEN: 'bot123',
      NOTIFIER_TELEGRAM_CHAT_ID: '-100456',
    });
    expect(notifiers.some((n) => n instanceof TelegramNotifier)).toBe(true);
  });

  it('excludes TelegramNotifier when only token is set', () => {
    const notifiers = buildNotifiers({ ...baseConfig, NOTIFIER_TELEGRAM_BOT_TOKEN: 'bot123' });
    expect(notifiers.some((n) => n instanceof TelegramNotifier)).toBe(false);
  });

  it('returns only console notifier when nothing extra is configured', () => {
    const notifiers = buildNotifiers(baseConfig);
    expect(notifiers).toHaveLength(1);
    expect(notifiers[0]).toBeInstanceOf(ConsoleNotifier);
  });
});
