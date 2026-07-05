import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import {
  makeFakeRescoreDeps,
  makeServiceFromFakes,
} from '../../portfolio/__tests__/rescore-test-helpers.js';
import { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import { createPortfolioRouter } from '../routes/portfolio.js';
import { errorHandler } from '../middleware/error-handler.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function buildApp(provider: SqliteProvider): {
  app: express.Express;
  outcomeRepo: OutcomeRepository;
  manager: PortfolioManager;
} {
  const outcomeRepo = new OutcomeRepository(provider);
  const manager = new PortfolioManager(new PortfolioRepository(provider), 25, 60);
  const deps = makeFakeRescoreDeps(provider);
  const { service } = makeServiceFromFakes(deps);
  manager.setRescoreService(service);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/portfolio', createPortfolioRouter(manager, outcomeRepo));
  app.use(errorHandler);
  return { app, outcomeRepo, manager };
}

describe('Portfolio API', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
  });

  describe('GET /api/v1/portfolio', () => {
    it('returns an empty array on a fresh database', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).get('/api/v1/portfolio');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ portfolio: [] });
    });
  });

  describe('POST /api/v1/portfolio', () => {
    it('creates a portfolio entry', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).post('/api/v1/portfolio').send({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-01-01T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });
      expect(res.status).toBe(201);
      expect(res.body.entry.domain).toBe('alpha.com');
    });
  });

  describe('POST /api/v1/portfolio/verdicts', () => {
    it('refreshes verdicts on a non-empty portfolio', async () => {
      const { app, manager } = buildApp(provider);
      await manager.add({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-12-31T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });

      const res = await request(app).post('/api/v1/portfolio/verdicts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns ok on an empty portfolio', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).post('/api/v1/portfolio/verdicts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('POST /api/v1/portfolio/rescore', () => {
    it('returns a per-domain summary for a non-empty portfolio', async () => {
      const { app, manager } = buildApp(provider);
      await manager.add({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-12-31T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });

      const res = await request(app).post('/api/v1/portfolio/rescore');
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].domain).toBe('alpha.com');
      expect(res.body.results[0].calibratedScore).toBeGreaterThanOrEqual(0);
      expect(res.body.results[0].trademarkVerdict).toBe(GateVerdict.Clear);
    });

    it('returns an empty result list on a fresh portfolio', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).post('/api/v1/portfolio/rescore');
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });
  });

  describe('GET /api/v1/portfolio/:domain/outcomes', () => {
    it('returns an empty array when no outcomes exist', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).get('/api/v1/portfolio/alpha.com/outcomes');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcomes: [] });
    });
  });

  describe('POST /api/v1/portfolio/:domain/outcomes', () => {
    it('records an outcome and returns 201 with the stored row', async () => {
      const { app, manager, outcomeRepo } = buildApp(provider);
      await manager.add({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-12-31T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });

      const res = await request(app).post('/api/v1/portfolio/alpha.com/outcomes').send({
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
        salePriceEur: 1500,
        venue: 'sedo',
      });

      expect(res.status).toBe(201);
      expect(res.body.outcome.domain).toBe('alpha.com');
      expect(res.body.outcome.type).toBe('sold');
      expect(res.body.outcome.salePriceEur).toBe(1500);

      const stored = await outcomeRepo.findByDomain('alpha.com');
      expect(stored).toHaveLength(1);
    });

    it('rejects an unknown type with 400 and a clear error', async () => {
      const { app, manager } = buildApp(provider);
      await manager.add({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-12-31T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });

      const res = await request(app)
        .post('/api/v1/portfolio/alpha.com/outcomes')
        .send({ type: 'parachuted', occurredAt: '2026-04-15T00:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when the domain is not in the portfolio', async () => {
      const { app } = buildApp(provider);
      const res = await request(app)
        .post('/api/v1/portfolio/ghost.com/outcomes')
        .send({ type: 'sold', occurredAt: '2026-04-15T00:00:00.000Z' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DOMAIN_NOT_FOUND');
    });
  });

  describe('GET /api/v1/portfolio/:domain/outcomes/stats', () => {
    it('returns aggregate counts and realised revenue', async () => {
      const { app, manager, outcomeRepo } = buildApp(provider);
      await manager.add({
        domain: 'alpha.com',
        tld: '.com',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        renewalDate: '2026-12-31T00:00:00.000Z',
        acquisitionCost: 12,
        renewalCost: 12,
        registrar: 'namecheap',
      });
      await outcomeRepo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-01T00:00:00.000Z',
        salePriceEur: 800,
      });
      await outcomeRepo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-05-01T00:00:00.000Z',
        salePriceEur: 1200,
      });
      await outcomeRepo.insert({
        domain: 'alpha.com',
        type: 'renewed',
        occurredAt: '2025-12-01T00:00:00.000Z',
      });

      const res = await request(app).get('/api/v1/portfolio/alpha.com/outcomes/stats');
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe('alpha.com');
      expect(res.body.stats.sold).toBe(2);
      expect(res.body.stats.renewed).toBe(1);
      expect(res.body.stats.totalRealisedEur).toBe(2000);
    });
  });
});
