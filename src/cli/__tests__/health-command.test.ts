import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { runMigrations } from '../../db/migrator.js';
import { registerHealthCommand } from '../commands/health-command.js';
import type { Config } from '../../config.js';

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    DATABASE_BUSY_TIMEOUT: 30000,
    PORT: 3000,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_HOLDING_YEARS: 3,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://api.euipo.europa.eu/api',
    TM_CACHE_TTL_DAYS: 7,
    KEYWORD_DATA_PATH: './data/keywords.json',
    KEYWORD_PROVIDER: 'manual',
    COMPS_DATA_PATH: './data/comps.csv',
    COMPS_PROVIDER: 'manual',
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
    USPTO_RATE_LIMIT_TOKENS: 5,
    USPTO_RATE_LIMIT_INTERVAL_MS: 1000,
    EUIPO_RATE_LIMIT_TOKENS: 5,
    EUIPO_RATE_LIMIT_INTERVAL_MS: 1000,
    WHOIS_RATE_LIMIT_TOKENS: 1,
    WHOIS_RATE_LIMIT_INTERVAL_MS: 2000,
    BUY_MAX_ABSOLUTE_CAP: 500,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
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
    LISTING_PROVIDER: 'manual' as const,
    LISTING_DEFAULT_MARKETPLACE: 'manual' as const,
    LISTING_DEFAULT_PRICE_MULTIPLIER: 1.0,
    WAYBACK_ENABLED: true,
    WAYBACK_RATE_LIMIT_TOKENS: 5,
    WAYBACK_RATE_LIMIT_INTERVAL_MS: 12000,
    WAYBACK_TIMEOUT_MS: 10000,
    WAYBACK_BATCH_CONCURRENCY: 3,
    SCORING_BATCH_CONCURRENCY: 5,
    PUBLIC_CACHE_TTL_MS: 300000,
    WAYBACK_CDX_PAGE_SIZE: 5000,
    DNS_PARKING_CHECK_ENABLED: false,
    TRUST_PROXY_DEPTH: 1,
    AUTH_PROVIDER: 'env',
    DNS_PARKING_IPS_PATH: undefined,
    PUBLIC_SCORES_RETENTION_DAYS: 90,
    EVENTS_RETENTION_DAYS: 180,
    DNS_SEMAPHORE_CONCURRENCY: 100,
    DNS_RESOLVER_URLS: undefined,
    DNS_HEALTH_CHECK_DOMAIN: 'google.com',
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
    ...overrides,
  };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  const mockWrite = (s: string): boolean => {
    buffer += s;
    return true;
  };
  process.stdout.write = mockWrite as typeof process.stdout.write;
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = original;
    })
    .then((): string => buffer);
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function runHealth(...args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerHealthCommand(program, { db, config });
  return captureStdout(() => program.parseAsync(['node', 'dominus', 'health', ...args]));
}

let db: Database.Database;
let config: Config;

beforeEach(() => {
  db = freshDb();
  config = buildConfig();
});

describe('health command', () => {
  it('reports healthy state when database is connected', async () => {
    const output = await runHealth();
    expect(output).toMatch(/Status:\s+ok/);
    expect(output).toMatch(/DOMINUS v0\./);
    expect(output).toMatch(/Database:\s+connected/);
    expect(output).toMatch(/Providers:/);
  });

  it('includes uptime and version in output', async () => {
    const output = await runHealth();
    expect(output).toMatch(/DOMINUS v/);
    expect(output).toMatch(/Uptime:/);
  });

  it('reports all six providers in the table', async () => {
    const output = await runHealth();
    expect(output).toMatch(/USPTO/);
    expect(output).toMatch(/EUIPO/);
    expect(output).toMatch(/KeywordPlanner/);
    expect(output).toMatch(/NameBio/);
    expect(output).toMatch(/WHOIS/);
  });

  it('outputs valid JSON with --json flag', async () => {
    const output = await runHealth('--json');
    const parsed = JSON.parse(output.trim());
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('version');
    expect(parsed.version).toMatch(/^0\.\d+\.\d+-dev$/);
    expect(parsed).toHaveProperty('uptime');
    expect(parsed).toHaveProperty('database', 'connected');
    expect(parsed).toHaveProperty('providers');
    expect(parsed.providers).toHaveLength(7);
  });

  it('includes provider configured status in JSON output', async () => {
    config = buildConfig({
      EUIPO_CLIENT_ID: 'test-client',
      EUIPO_CLIENT_SECRET: 'test-secret',
      KEYWORD_DATA_PATH: './keywords.json',
      KEYWORD_PROVIDER: 'manual',
      COMPS_DATA_PATH: './comps.csv',
      COMPS_PROVIDER: 'manual',
    });
    const output = await runHealth('--json');
    const parsed = JSON.parse(output.trim());
    const euipo = parsed.providers.find((p: { name: string }) => p.name === 'EUIPO');
    expect(euipo.configured).toBe(true);
    const kw = parsed.providers.find((p: { name: string }) => p.name === 'KeywordPlanner');
    expect(kw.configured).toBe(true);
  });
});
