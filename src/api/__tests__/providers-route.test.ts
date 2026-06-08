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
    CORS_ORIGIN: '*',
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
