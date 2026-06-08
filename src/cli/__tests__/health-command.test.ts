import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { runMigrations } from '../../db/migrator.js';
import { registerHealthCommand } from '../commands/health-command.js';
import type { Config } from '../../config.js';

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    PORT: 3000,
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://api.euipo.europa.eu/api',
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
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
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
    expect(output).toMatch(/DOMINUS v0\.2\.0/);
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
    expect(parsed).toHaveProperty('version', '0.2.0');
    expect(parsed).toHaveProperty('uptime');
    expect(parsed).toHaveProperty('database', 'connected');
    expect(parsed).toHaveProperty('providers');
    expect(parsed.providers).toHaveLength(6);
  });

  it('includes provider configured status in JSON output', async () => {
    config = buildConfig({
      EUIPO_CLIENT_ID: 'test-client',
      EUIPO_CLIENT_SECRET: 'test-secret',
      KEYWORD_DATA_PATH: './keywords.json',
      COMPS_DATA_PATH: './comps.csv',
    });
    const output = await runHealth('--json');
    const parsed = JSON.parse(output.trim());
    const euipo = parsed.providers.find((p: { name: string }) => p.name === 'EUIPO');
    expect(euipo.configured).toBe(true);
    const kw = parsed.providers.find((p: { name: string }) => p.name === 'KeywordPlanner');
    expect(kw.configured).toBe(true);
  });
});
