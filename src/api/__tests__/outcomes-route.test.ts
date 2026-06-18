import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { createOutcomesRouter } from '../routes/outcomes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function seedPortfolio(provider: SqliteProvider, domain: string): void {
  const repo = new PortfolioRepository(provider);
  repo.insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01',
    renewalDate: '2026-01-01',
    acquisitionCost: 10,
    renewalCost: 10,
    registrar: 'test',
  });
}

describe('Standalone outcomes API', () => {
  let provider: SqliteProvider;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    provider = openTestDb();
    outcomeRepo = new OutcomeRepository(provider);
  });

  it('POST /api/v1/outcomes records an outcome (with domain in body)', async () => {
    seedPortfolio(provider, 'example.com');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/v1/outcomes')
      .send({ domain: 'example.com', type: 'sold', occurredAt: '2025-06-01', salePriceEur: 1000 });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toHaveProperty('domain', 'example.com');
    expect(res.body.outcome).toHaveProperty('type', 'sold');
  });

  it('POST /api/v1/outcomes returns 400 on invalid body', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/v1/outcomes')
      .send({ domain: 'example.com', type: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('GET /api/v1/outcomes lists all outcomes', async () => {
    seedPortfolio(provider, 'alpha.com');
    seedPortfolio(provider, 'beta.com');
    outcomeRepo.insert({
      domain: 'alpha.com',
      type: 'sold',
      occurredAt: '2025-06-01',
      salePriceEur: 500,
    });
    outcomeRepo.insert({ domain: 'beta.com', type: 'renewed', occurredAt: '2025-07-01' });

    const app = express();
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/outcomes');
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(2);
  });

  it('GET /api/v1/outcomes?type=sold filters by type', async () => {
    seedPortfolio(provider, 'alpha.com');
    outcomeRepo.insert({
      domain: 'alpha.com',
      type: 'sold',
      occurredAt: '2025-06-01',
      salePriceEur: 500,
    });

    const app = express();
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/outcomes?type=sold');
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0]).toHaveProperty('type', 'sold');
  });

  it('GET /api/v1/outcomes/stats/:domain returns aggregate stats', async () => {
    seedPortfolio(provider, 'alpha.com');
    outcomeRepo.insert({
      domain: 'alpha.com',
      type: 'sold',
      occurredAt: '2025-06-01',
      salePriceEur: 500,
    });

    const app = express();
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/outcomes/stats/alpha.com');
    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveProperty('sold');
    expect(res.body.stats).toHaveProperty('totalRealisedEur');
  });

  it('POST /api/v1/outcomes returns 404 for domain not in portfolio', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/outcomes', createOutcomesRouter(outcomeRepo));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/v1/outcomes')
      .send({ domain: 'nonexistent.com', type: 'sold', occurredAt: '2025-06-01' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOMAIN_NOT_FOUND');
  });

  it('GET /api/v1/outcomes/stats/:domain returns 500 when repository throws', async () => {
    const brokenRepo = {
      findAll: vi.fn(),
      findByType: vi.fn(),
      insert: vi.fn(),
      statsByDomain: vi.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
    } as unknown as OutcomeRepository;
    const app = express();
    app.use('/api/v1/outcomes', createOutcomesRouter(brokenRepo));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/outcomes/stats/alpha.com');
    expect(res.status).toBe(500);
  });

  it('GET /api/v1/outcomes returns 500 when repository findAll throws', async () => {
    const brokenRepo = {
      findAll: vi.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
      findByType: vi.fn(),
      insert: vi.fn(),
      statsByDomain: vi.fn(),
    } as unknown as OutcomeRepository;
    const app = express();
    app.use('/api/v1/outcomes', createOutcomesRouter(brokenRepo));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/outcomes');
    expect(res.status).toBe(500);
  });
});
