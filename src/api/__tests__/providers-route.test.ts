import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProvidersRouter } from '../routes/providers.js';
import { errorHandler } from '../middleware/error-handler.js';
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
    SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
    WATCHLIST_POLL_INTERVAL_HOURS: 6,
    WATCHLIST_RDAP_DELAY_MS: 200,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    RATE_LIMIT_MAX: 100,
    KEYWORD_DATA_PATH: undefined,
    COMPS_DATA_PATH: undefined,
    EUIPO_CLIENT_ID: undefined,
    EUIPO_CLIENT_SECRET: undefined,
    SCORING_WEIGHTS_OVERRIDE: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
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

describe('GET /api/providers/status', () => {
  it('returns provider statuses for all 6 providers', async () => {
    const app = express();
    app.use('/api/providers', createProvidersRouter(buildConfig()));
    app.use(errorHandler);

    const res = await request(app).get('/api/providers/status');
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(6);
    const names = res.body.providers.map((p: { name: string }) => p.name) as string[];
    expect(names).toContain('USPTO');
    expect(names).toContain('EUIPO');
    expect(names).toContain('KeywordPlanner');
    expect(names).toContain('NameBio');
    expect(names).toContain('WHOIS');
    expect(names).toContain('CloudflareRegistrar');
  });

  it('reports EUIPO as not configured when credentials are missing', async () => {
    const app = express();
    app.use('/api/providers', createProvidersRouter(buildConfig()));
    app.use(errorHandler);

    const res = await request(app).get('/api/providers/status');
    const euipo = res.body.providers.find((p: { name: string }) => p.name === 'EUIPO');
    expect(euipo.configured).toBe(false);
  });

  it('reports EUIPO as configured when credentials are present', async () => {
    const app = express();
    app.use(
      '/api/providers',
      createProvidersRouter(buildConfig({ EUIPO_CLIENT_ID: 'abc', EUIPO_CLIENT_SECRET: 'xyz' })),
    );
    app.use(errorHandler);

    const res = await request(app).get('/api/providers/status');
    const euipo = res.body.providers.find((p: { name: string }) => p.name === 'EUIPO');
    expect(euipo.configured).toBe(true);
  });
});
