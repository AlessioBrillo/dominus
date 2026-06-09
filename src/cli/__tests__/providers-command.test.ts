import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { runMigrations } from '../../db/migrator.js';
import { registerProvidersCommand } from '../commands/providers-command.js';
import type { Config } from '../../config.js';
import {
  reportProviderStatuses,
  warnEuipoIfMissing,
  warnCloudflareIfMissing,
} from '../../app/provider-status.js';

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    PORT: 3000,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_HOLDING_YEARS: 3,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://euipo.europa.eu/api',
    TM_CACHE_TTL_DAYS: 7,
    DNS_BULK_CONCURRENCY: 10,
    WHOIS_LOOKUP_TIMEOUT: 10_000,
    BUY_MAX_ABSOLUTE_CAP: 500,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
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
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
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
    ...overrides,
  };
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = original;
    })
    .then((): string => buffer);
}

interface ProviderRow {
  name: string;
  configured: boolean;
  note: string;
}

describe('reportProviderStatuses', () => {
  it('reports EUIPO as not configured when credentials are missing', () => {
    // Act
    const rows = reportProviderStatuses(buildConfig());

    // Assert
    const euipo = rows.find((r) => r.name === 'EUIPO');
    expect(euipo?.configured).toBe(false);
    expect(euipo?.note).toMatch(/EUIPO_CLIENT_ID/);
  });

  it('reports EUIPO as configured when both credentials are present', () => {
    // Act
    const rows = reportProviderStatuses(
      buildConfig({ EUIPO_CLIENT_ID: 'abc123def', EUIPO_CLIENT_SECRET: 's3cr3t' }),
    );

    // Assert
    const euipo = rows.find((r) => r.name === 'EUIPO');
    expect(euipo?.configured).toBe(true);
    expect(euipo?.note).toContain('abc123');
  });

  it('reports KeywordPlanner as not configured when KEYWORD_DATA_PATH is unset', () => {
    // Act
    const rows = reportProviderStatuses(buildConfig());

    // Assert
    const kp = rows.find((r) => r.name === 'KeywordPlanner');
    expect(kp?.configured).toBe(false);
    expect(kp?.note).toMatch(/KEYWORD_DATA_PATH/);
  });

  it('reports NameBio as not configured when COMPS_DATA_PATH is unset', () => {
    // Act
    const rows = reportProviderStatuses(buildConfig());

    // Assert
    const nb = rows.find((r) => r.name === 'NameBio');
    expect(nb?.configured).toBe(false);
    expect(nb?.note).toMatch(/COMPS_DATA_PATH/);
  });

  it('always reports USPTO as configured (no key required)', () => {
    // Act
    const rows = reportProviderStatuses(buildConfig());

    // Assert
    const uspto = rows.find((r) => r.name === 'USPTO');
    expect(uspto?.configured).toBe(true);
  });

  it('reports CloudflareRegistrar as not configured when credentials missing', () => {
    const rows = reportProviderStatuses(buildConfig());
    const cf = rows.find((r) => r.name === 'CloudflareRegistrar');
    expect(cf?.configured).toBe(false);
    expect(cf?.note).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  it('reports CloudflareRegistrar as configured when both credentials present', () => {
    const rows = reportProviderStatuses(
      buildConfig({ CLOUDFLARE_API_TOKEN: 'token123', CLOUDFLARE_ACCOUNT_ID: 'acc456' }),
    );
    const cf = rows.find((r) => r.name === 'CloudflareRegistrar');
    expect(cf?.configured).toBe(true);
    expect(cf?.note).toContain('acc456');
  });

  it('reports 6 provider status rows', () => {
    const rows = reportProviderStatuses(buildConfig());
    expect(rows).toHaveLength(6);
  });
});

describe('warnEuipoIfMissing', () => {
  it('logs a warning when EUIPO credentials are missing', () => {
    // Arrange
    const warn = vi.fn();
    const stubLogger = { warn };

    // Act
    warnEuipoIfMissing(buildConfig(), stubLogger);

    // Assert
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/EUIPO/);
  });

  it('is silent when EUIPO credentials are present', () => {
    // Arrange
    const warn = vi.fn();
    const stubLogger = { warn };

    // Act
    warnEuipoIfMissing(
      buildConfig({ EUIPO_CLIENT_ID: 'abc123def', EUIPO_CLIENT_SECRET: 's3cr3t' }),
      stubLogger,
    );

    // Assert
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('warnCloudflareIfMissing', () => {
  it('logs a warning when Cloudflare credentials are missing', () => {
    const warn = vi.fn();
    const stubLogger = { warn };

    warnCloudflareIfMissing(buildConfig(), stubLogger);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/Cloudflare/);
  });

  it('is silent when Cloudflare credentials are present', () => {
    const warn = vi.fn();
    const stubLogger = { warn };

    warnCloudflareIfMissing(
      buildConfig({ CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'acc' }),
      stubLogger,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('CLI: dominus providers', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.close();
  });

  it('status prints a table of providers', async () => {
    // Arrange
    const program = new Command();
    const config = buildConfig();
    registerProvidersCommand(program, { config });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'providers', 'status']);
    });

    // Assert
    expect(out).toContain('PROVIDER');
    expect(out).toContain('USPTO');
    expect(out).toContain('EUIPO');
    expect(out).toContain('KeywordPlanner');
    expect(out).toContain('NameBio');
    expect(out).toContain('WHOIS');
    expect(out).toContain('CloudflareRegistrar');
  });

  it('status --json emits a JSON array', async () => {
    // Arrange
    const program = new Command();
    const config = buildConfig({ EUIPO_CLIENT_ID: 'abc', EUIPO_CLIENT_SECRET: 'xyz' });
    registerProvidersCommand(program, { config });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'providers', 'status', '--json']);
    });

    // Assert
    const parsed = JSON.parse(out) as ProviderRow[];
    expect(parsed).toHaveLength(6);
    const euipo = parsed.find((r) => r.name === 'EUIPO');
    expect(euipo?.configured).toBe(true);
    const cf = parsed.find((r) => r.name === 'CloudflareRegistrar');
    expect(cf?.configured).toBe(false);
  });
});
